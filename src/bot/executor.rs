use anyhow::Result;
use chrono::Utc;
use polymarket_client_sdk::clob::Client;
use polymarket_client_sdk::clob::types::request::OrderBookSummaryRequest;
use polymarket_client_sdk::clob::types::response::OrderSummary;
use polymarket_client_sdk::types::U256;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use std::str::FromStr;

use super::classifier::TradeIntent;
use super::config::BotConfig;
use super::ledger::{Ledger, LedgerRecord};
use super::positions::{OpenPosition, Positions};

#[derive(Debug, Clone, Copy)]
pub struct PaperFillPlan {
    pub shares: f64,
    pub price: f64,
    pub cost: f64,
}

/// Pure decision: given a snapshot of the book and intent/config/bank,
/// returns either a fill plan or a skip reason. Easily unit-testable.
pub fn plan_paper_fill(
    asks: &[OrderSummary],
    bids: &[OrderSummary],
    intent_shares: f64,
    cfg: &BotConfig,
    bank: f64,
) -> Result<PaperFillPlan, ExecSkipReason> {
    let best_ask = asks.iter().map(|o| o.price).min();
    let best_bid = bids.iter().map(|o| o.price).max();
    let (best_ask, best_bid) = match (best_ask, best_bid) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err(ExecSkipReason::NoLiquidity),
    };
    let spread_cents = ((best_ask - best_bid) * Decimal::from(100))
        .to_f64()
        .unwrap_or(0.0)
        .max(0.0) as u32;
    if spread_cents > cfg.spread_skip_cents {
        return Err(ExecSkipReason::SpreadTooWide {
            cents: spread_cents,
        });
    }

    let ask_depth: Decimal = asks
        .iter()
        .filter(|o| o.price == best_ask)
        .map(|o| o.size)
        .sum();
    let ask_depth_f = ask_depth.to_f64().unwrap_or(0.0);
    let shares = intent_shares.min(ask_depth_f);
    if shares <= 0.0 {
        return Err(ExecSkipReason::NoLiquidity);
    }

    let price = best_ask.to_f64().unwrap_or(0.0);
    let cost = shares * price;
    if cost > bank {
        return Err(ExecSkipReason::InsufficientBank {
            needed: cost,
            available: bank,
        });
    }
    Ok(PaperFillPlan {
        shares,
        price,
        cost,
    })
}

#[derive(Debug)]
pub enum ExecOutcome {
    Filled { shares: f64, price: f64, cost: f64 },
    Skipped(ExecSkipReason),
}

#[derive(Debug, Clone)]
pub enum ExecSkipReason {
    SpreadTooWide { cents: u32 },
    NoLiquidity,
    InsufficientBank { needed: f64, available: f64 },
    InvalidTokenId,
    MarketClosed,
}

impl ExecSkipReason {
    pub fn label(&self) -> &'static str {
        match self {
            Self::SpreadTooWide { .. } => "spread_too_wide",
            Self::NoLiquidity => "no_liquidity",
            Self::InsufficientBank { .. } => "insufficient_bank",
            Self::InvalidTokenId => "invalid_token_id",
            Self::MarketClosed => "market_closed",
        }
    }
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::SpreadTooWide { cents } => Some(format!("{cents} cents")),
            Self::InsufficientBank { needed, available } => {
                Some(format!("need ${needed:.2}, have ${available:.2}"))
            }
            _ => None,
        }
    }
}

pub struct PaperExecutor {
    pub clob: Client,
    pub bank_usdc: f64,
}

impl PaperExecutor {
    pub fn new(bank_usdc: f64) -> Self {
        Self {
            clob: Client::default(),
            bank_usdc,
        }
    }

    pub async fn enter(
        &mut self,
        intent: &TradeIntent,
        cfg: &BotConfig,
        ledger: &mut Ledger,
        positions: &mut Positions,
    ) -> Result<ExecOutcome> {
        let token_id = match U256::from_str(&intent.token_id) {
            Ok(t) => t,
            Err(_) => return Ok(ExecOutcome::Skipped(ExecSkipReason::InvalidTokenId)),
        };

        let req = OrderBookSummaryRequest::builder()
            .token_id(token_id)
            .build();
        let book = match self.clob.order_book(&req).await {
            Ok(b) => b,
            Err(e) => {
                // A 404 means the market is already closed/resolved and the
                // book is gone — Bonereaper traded right at the wire and we
                // were too late. Treat as a clean skip, not an error.
                let msg = format!("{e:#}");
                if msg.contains("404") {
                    return Ok(ExecOutcome::Skipped(ExecSkipReason::MarketClosed));
                }
                return Err(anyhow::anyhow!(e).context("failed to fetch order book"));
            }
        };

        let plan = match plan_paper_fill(
            &book.asks,
            &book.bids,
            intent.size_shares,
            cfg,
            self.bank_usdc,
        ) {
            Ok(p) => p,
            Err(reason) => return Ok(ExecOutcome::Skipped(reason)),
        };

        self.bank_usdc -= plan.cost;
        let now = Utc::now();
        ledger.append(&LedgerRecord::PaperEntry {
            ts: now,
            tx_hash: intent.tx_hash.clone(),
            market_id: intent.market_id.clone(),
            token_id: intent.token_id.clone(),
            side: "buy".to_string(),
            size_shares: plan.shares,
            price: plan.price,
            cost_usdc: plan.cost,
            master_size_shares: intent.size_shares,
            market_slug: intent.market_slug.clone(),
        })?;
        positions.open(OpenPosition {
            market_id: intent.market_id.clone(),
            token_id: intent.token_id.clone(),
            side: "buy".to_string(),
            size_shares: plan.shares,
            entry_price: plan.price,
            opened_at: now,
            market_slug: intent.market_slug.clone(),
        })?;

        Ok(ExecOutcome::Filled {
            shares: plan.shares,
            price: plan.price,
            cost: plan.cost,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn cfg() -> BotConfig {
        BotConfig::default()
    }

    fn level(price: Decimal, size: Decimal) -> OrderSummary {
        OrderSummary::builder().price(price).size(size).build()
    }

    #[test]
    fn empty_book_returns_no_liquidity() {
        let r = plan_paper_fill(&[], &[], 20.0, &cfg(), 100.0);
        assert!(matches!(r, Err(ExecSkipReason::NoLiquidity)));
    }

    #[test]
    fn only_one_side_returns_no_liquidity() {
        let asks = vec![level(dec!(0.5), dec!(50))];
        let r = plan_paper_fill(&asks, &[], 20.0, &cfg(), 100.0);
        assert!(matches!(r, Err(ExecSkipReason::NoLiquidity)));
    }

    #[test]
    fn spread_one_cent_passes_default() {
        let asks = vec![level(dec!(0.50), dec!(50))];
        let bids = vec![level(dec!(0.49), dec!(50))];
        let r = plan_paper_fill(&asks, &bids, 20.0, &cfg(), 100.0).unwrap();
        assert!((r.shares - 20.0).abs() < 1e-9);
        assert!((r.price - 0.50).abs() < 1e-9);
        assert!((r.cost - 10.0).abs() < 1e-9);
    }

    #[test]
    fn spread_three_cents_fails_default() {
        let asks = vec![level(dec!(0.50), dec!(50))];
        let bids = vec![level(dec!(0.47), dec!(50))];
        let r = plan_paper_fill(&asks, &bids, 20.0, &cfg(), 100.0);
        match r {
            Err(ExecSkipReason::SpreadTooWide { cents }) => assert_eq!(cents, 3),
            other => panic!("expected SpreadTooWide(3), got {other:?}"),
        }
    }

    #[test]
    fn shallow_top_caps_to_depth() {
        let asks = vec![level(dec!(0.50), dec!(5)), level(dec!(0.51), dec!(100))];
        let bids = vec![level(dec!(0.49), dec!(50))];
        let r = plan_paper_fill(&asks, &bids, 20.0, &cfg(), 100.0).unwrap();
        assert!((r.shares - 5.0).abs() < 1e-9);
        assert!((r.price - 0.50).abs() < 1e-9);
        assert!((r.cost - 2.5).abs() < 1e-9);
    }

    #[test]
    fn multiple_levels_at_same_price_sum_depth() {
        let asks = vec![
            level(dec!(0.50), dec!(8)),
            level(dec!(0.50), dec!(4)),
            level(dec!(0.51), dec!(99)),
        ];
        let bids = vec![level(dec!(0.49), dec!(50))];
        let r = plan_paper_fill(&asks, &bids, 20.0, &cfg(), 100.0).unwrap();
        assert!((r.shares - 12.0).abs() < 1e-9);
    }

    #[test]
    fn picks_min_ask_when_unsorted() {
        let asks = vec![
            level(dec!(0.55), dec!(99)),
            level(dec!(0.50), dec!(20)),
            level(dec!(0.52), dec!(99)),
        ];
        let bids = vec![level(dec!(0.49), dec!(50))];
        let r = plan_paper_fill(&asks, &bids, 10.0, &cfg(), 100.0).unwrap();
        assert!((r.price - 0.50).abs() < 1e-9);
    }

    #[test]
    fn insufficient_bank_rejects() {
        let asks = vec![level(dec!(0.50), dec!(100))];
        let bids = vec![level(dec!(0.49), dec!(100))];
        let r = plan_paper_fill(&asks, &bids, 100.0, &cfg(), 10.0);
        match r {
            Err(ExecSkipReason::InsufficientBank { needed, available }) => {
                assert!((needed - 50.0).abs() < 1e-9);
                assert!((available - 10.0).abs() < 1e-9);
            }
            other => panic!("expected InsufficientBank, got {other:?}"),
        }
    }

    #[test]
    fn zero_intent_shares_no_liquidity() {
        let asks = vec![level(dec!(0.50), dec!(50))];
        let bids = vec![level(dec!(0.49), dec!(50))];
        let r = plan_paper_fill(&asks, &bids, 0.0, &cfg(), 100.0);
        assert!(matches!(r, Err(ExecSkipReason::NoLiquidity)));
    }

    #[test]
    fn custom_spread_cap_in_config() {
        let mut c = cfg();
        c.spread_skip_cents = 5;
        let asks = vec![level(dec!(0.50), dec!(50))];
        let bids = vec![level(dec!(0.46), dec!(50))];
        assert!(plan_paper_fill(&asks, &bids, 10.0, &c, 100.0).is_ok());
    }
}
