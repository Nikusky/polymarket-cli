use std::str::FromStr;

use polymarket_client_sdk::gamma::types::response::Market;
use polymarket_client_sdk::types::U256;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;

use super::positions::OpenPosition;

#[derive(Debug, Clone, PartialEq)]
pub struct Settlement {
    pub payout_per_share: f64,
    pub proceeds: f64,
    pub realized_pnl: f64,
}

/// Returns `Some(Settlement)` if the market is resolved and our token's payout is
/// definitive (a 1.0 entry exists in outcome_prices). Returns `None` while the
/// market is still open or while we're waiting for the resolver to write the
/// final outcome prices.
pub fn settle(position: &OpenPosition, market: &Market) -> Option<Settlement> {
    if market.closed != Some(true) {
        return None;
    }
    let prices = market.outcome_prices.as_ref()?;
    let token_ids = market.clob_token_ids.as_ref()?;
    if prices.len() != token_ids.len() || prices.is_empty() {
        return None;
    }

    let has_winner = prices.iter().any(|p| *p == Decimal::from(1));
    if !has_winner {
        return None;
    }

    let pos_token = U256::from_str(&position.token_id).ok()?;
    let idx = token_ids.iter().position(|t| *t == pos_token)?;
    let payout = prices.get(idx)?.to_f64()?;

    let proceeds = position.size_shares * payout;
    let cost_basis = position.size_shares * position.entry_price;
    Some(Settlement {
        payout_per_share: payout,
        proceeds,
        realized_pnl: proceeds - cost_basis,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use polymarket_client_sdk::gamma::types::response::Market;
    use rust_decimal_macros::dec;

    fn token_id(n: u8) -> U256 {
        U256::from(n as u64)
    }

    fn position(token: u8, size: f64, entry: f64) -> OpenPosition {
        OpenPosition {
            market_id: "0xmkt".into(),
            token_id: token_id(token).to_string(),
            side: "buy".into(),
            size_shares: size,
            entry_price: entry,
            opened_at: Utc::now(),
            market_slug: "btc-updown-5m-x".into(),
        }
    }

    fn market_with(
        closed: Option<bool>,
        prices: Option<Vec<Decimal>>,
        tokens: Option<Vec<U256>>,
    ) -> Market {
        let mut m = Market::builder().id("1".to_string()).build();
        m.closed = closed;
        m.outcome_prices = prices;
        m.clob_token_ids = tokens;
        m
    }

    #[test]
    fn unresolved_market_returns_none() {
        let pos = position(1, 20.0, 0.5);
        let m = market_with(
            Some(false),
            Some(vec![dec!(0.5), dec!(0.5)]),
            Some(vec![token_id(1), token_id(2)]),
        );
        assert_eq!(settle(&pos, &m), None);
    }

    #[test]
    fn closed_but_no_winner_yet_returns_none() {
        let pos = position(1, 20.0, 0.5);
        let m = market_with(
            Some(true),
            Some(vec![dec!(0.5), dec!(0.5)]),
            Some(vec![token_id(1), token_id(2)]),
        );
        assert_eq!(settle(&pos, &m), None);
    }

    #[test]
    fn winning_position_settles_to_payout_1() {
        let pos = position(1, 20.0, 0.5);
        let m = market_with(
            Some(true),
            Some(vec![dec!(1), dec!(0)]),
            Some(vec![token_id(1), token_id(2)]),
        );
        let s = settle(&pos, &m).expect("should settle");
        assert!((s.payout_per_share - 1.0).abs() < 1e-9);
        assert!((s.proceeds - 20.0).abs() < 1e-9);
        // PnL = proceeds - cost = 20 - 10 = +10
        assert!((s.realized_pnl - 10.0).abs() < 1e-9);
    }

    #[test]
    fn losing_position_settles_to_payout_0() {
        let pos = position(2, 20.0, 0.5);
        let m = market_with(
            Some(true),
            Some(vec![dec!(1), dec!(0)]),
            Some(vec![token_id(1), token_id(2)]),
        );
        let s = settle(&pos, &m).expect("should settle");
        assert!(s.payout_per_share.abs() < 1e-9);
        assert!(s.proceeds.abs() < 1e-9);
        assert!((s.realized_pnl + 10.0).abs() < 1e-9);
    }

    #[test]
    fn missing_outcome_prices_returns_none() {
        let pos = position(1, 20.0, 0.5);
        let m = market_with(Some(true), None, Some(vec![token_id(1), token_id(2)]));
        assert_eq!(settle(&pos, &m), None);
    }

    #[test]
    fn missing_token_ids_returns_none() {
        let pos = position(1, 20.0, 0.5);
        let m = market_with(Some(true), Some(vec![dec!(1), dec!(0)]), None);
        assert_eq!(settle(&pos, &m), None);
    }

    #[test]
    fn token_id_not_in_market_returns_none() {
        let pos = position(99, 20.0, 0.5);
        let m = market_with(
            Some(true),
            Some(vec![dec!(1), dec!(0)]),
            Some(vec![token_id(1), token_id(2)]),
        );
        assert_eq!(settle(&pos, &m), None);
    }

    #[test]
    fn mismatched_lengths_returns_none() {
        let pos = position(1, 20.0, 0.5);
        let m = market_with(
            Some(true),
            Some(vec![dec!(1)]),
            Some(vec![token_id(1), token_id(2)]),
        );
        assert_eq!(settle(&pos, &m), None);
    }
}
