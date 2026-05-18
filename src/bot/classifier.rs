use chrono::{DateTime, TimeZone, Utc};

use super::config::BotConfig;
use super::positions::Positions;

/// 5-minute BTC markets resolve 300 seconds after they open.
const FIVE_MIN_WINDOW_SECS: i64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone)]
pub struct TradeView {
    pub tx_hash: String,
    pub market_id: String,
    pub token_id: String,
    pub side: Side,
    pub size_shares: f64,
    pub price: f64,
    #[allow(dead_code)] // reserved for latency metrics
    pub timestamp: DateTime<Utc>,
    pub market_slug: String,
}

#[derive(Debug, Clone)]
pub struct TradeIntent {
    pub tx_hash: String,
    pub market_id: String,
    pub token_id: String,
    pub size_shares: f64,
    #[allow(dead_code)] // reserved for slippage-vs-master tracking
    pub master_price: f64,
    pub market_slug: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    NotBitcoinFiveMin,
    NotBuy,
    AlreadyOpen,
    OpenPositionsCap,
    TooCloseToResolve,
}

impl SkipReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NotBitcoinFiveMin => "not_btc_5min",
            Self::NotBuy => "not_buy",
            Self::AlreadyOpen => "already_open",
            Self::OpenPositionsCap => "open_positions_cap",
            Self::TooCloseToResolve => "too_close_to_resolve",
        }
    }
}

#[derive(Debug)]
pub enum Decision {
    Copy(TradeIntent),
    Skip(SkipReason),
}

/// Returns true if the slug looks like a copyable BTC up/down market.
/// Accepts both:
///   - `btc-updown-5m-<EPOCH>` (Chainlink, fast settle — but typically arrives
///     too stale to copy via REST polling; see bot-runlog.md)
///   - `bitcoin-up-or-down-*-et` (UMA, multi-hour settle — slower but copyable
///     via REST because the window is wide enough to absorb API lag)
///
/// `parse_resolve_ts` still only matches the 5m epoch form, so the time-gate
/// stays off on UMA markets and on by default for 5m markets.
pub fn is_btc_five_min_market(slug: &str) -> bool {
    let s = slug.to_ascii_lowercase();
    s.starts_with("btc-updown-5m-") || s.starts_with("bitcoin-up-or-down-")
}

/// Parse the resolution time out of a `btc-updown-5m-<EPOCH>` slug.
/// The trailing token is the market's open-time unix epoch (seconds);
/// resolution is open + 300s. Returns `None` for any other slug shape.
pub fn parse_resolve_ts(slug: &str) -> Option<DateTime<Utc>> {
    let s = slug.to_ascii_lowercase();
    let rest = s.strip_prefix("btc-updown-5m-")?;
    // Accept the bare epoch or `<epoch>-...` (defensive against future suffixes).
    let epoch_part = rest.split('-').next()?;
    let epoch: i64 = epoch_part.parse().ok()?;
    // Sanity bound: real Polymarket epochs are 10 digits (≥ 2001-09-09).
    // Reject short numbers like "2026" that happen to parse but aren't epochs.
    if epoch < 1_000_000_000 {
        return None;
    }
    let open = Utc.timestamp_opt(epoch, 0).single()?;
    Some(open + chrono::Duration::seconds(FIVE_MIN_WINDOW_SECS))
}

pub fn classify(
    trade: &TradeView,
    cfg: &BotConfig,
    positions: &Positions,
    resolve_ts: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Decision {
    if !is_btc_five_min_market(&trade.market_slug) {
        return Decision::Skip(SkipReason::NotBitcoinFiveMin);
    }
    if trade.side != Side::Buy {
        return Decision::Skip(SkipReason::NotBuy);
    }
    if positions.is_open(&trade.market_id) {
        return Decision::Skip(SkipReason::AlreadyOpen);
    }
    if positions.count() >= cfg.max_open_positions {
        return Decision::Skip(SkipReason::OpenPositionsCap);
    }
    if let Some(rts) = resolve_ts {
        let secs_left = (rts - now).num_seconds();
        if secs_left < cfg.min_time_to_resolve_secs {
            return Decision::Skip(SkipReason::TooCloseToResolve);
        }
    }

    // Size: copy_ratio × master, capped at max_position_usdc (in shares at master price).
    let target_shares = trade.size_shares * cfg.copy_ratio;
    let cost_at_master_price = target_shares * trade.price;
    let capped_shares = if cost_at_master_price > cfg.max_position_usdc {
        cfg.max_position_usdc / trade.price.max(1e-9)
    } else {
        target_shares
    };

    Decision::Copy(TradeIntent {
        tx_hash: trade.tx_hash.clone(),
        market_id: trade.market_id.clone(),
        token_id: trade.token_id.clone(),
        size_shares: capped_shares,
        master_price: trade.price,
        market_slug: trade.market_slug.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use std::env;
    use std::path::PathBuf;

    fn cfg() -> BotConfig {
        BotConfig::default()
    }

    fn tmp_path(name: &str) -> PathBuf {
        let pid = std::process::id();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        env::temp_dir().join(format!("classifier-{name}-{pid}-{nonce}.json"))
    }

    fn empty_positions(name: &str) -> Positions {
        Positions::load(tmp_path(name)).unwrap()
    }

    fn trade(slug: &str, side: Side) -> TradeView {
        TradeView {
            tx_hash: "0xabc".into(),
            market_id: "0xmkt".into(),
            token_id: "12345".into(),
            side,
            size_shares: 35.0,
            price: 0.5,
            timestamp: Utc::now(),
            market_slug: slug.into(),
        }
    }

    #[test]
    fn skips_non_btc_market() {
        let t = trade("trump-2028-winner", Side::Buy);
        let d = classify(&t, &cfg(), &empty_positions("a"), None, Utc::now());
        assert!(matches!(d, Decision::Skip(SkipReason::NotBitcoinFiveMin)));
    }

    #[test]
    fn accepts_bitcoin_up_or_down_slug() {
        // UMA hourly markets — slower to settle but copyable; re-enabled in P2.17.
        let t = trade("bitcoin-up-or-down-2026-05-17-14-00-utc", Side::Buy);
        let d = classify(&t, &cfg(), &empty_positions("b"), None, Utc::now());
        assert!(matches!(d, Decision::Copy(_)));
    }

    #[test]
    fn accepts_btc_updown_5m_slug() {
        let t = trade("btc-updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &cfg(), &empty_positions("c"), None, Utc::now());
        assert!(matches!(d, Decision::Copy(_)));
    }

    #[test]
    fn skips_sell_side() {
        let t = trade("btc-updown-5m-1779028200", Side::Sell);
        let d = classify(&t, &cfg(), &empty_positions("d"), None, Utc::now());
        assert!(matches!(d, Decision::Skip(SkipReason::NotBuy)));
    }

    #[test]
    fn skips_when_already_open() {
        let mut pos = empty_positions("e");
        pos.open(super::super::positions::OpenPosition {
            market_id: "0xmkt".into(),
            token_id: "12345".into(),
            side: "buy".into(),
            size_shares: 1.0,
            entry_price: 0.5,
            opened_at: Utc::now(),
            market_slug: "btc-updown-5m-1779028200".into(),
        })
        .unwrap();

        let t = trade("btc-updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &cfg(), &pos, None, Utc::now());
        assert!(matches!(d, Decision::Skip(SkipReason::AlreadyOpen)));
    }

    #[test]
    fn skips_too_close_to_resolve() {
        let now = Utc::now();
        let resolve = now + Duration::seconds(30); // <60s default
        let t = trade("btc-updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &cfg(), &empty_positions("f"), Some(resolve), now);
        assert!(matches!(d, Decision::Skip(SkipReason::TooCloseToResolve)));
    }

    #[test]
    fn caps_size_to_max_position() {
        let t = TradeView {
            size_shares: 1_000.0,
            price: 0.5,
            ..trade("btc-updown-5m-1779028200", Side::Buy)
        };
        // default max_position_usdc = 10, so cap at 10 / 0.5 = 20 shares
        let d = classify(&t, &cfg(), &empty_positions("g"), None, Utc::now());
        match d {
            Decision::Copy(intent) => {
                assert!(
                    (intent.size_shares - 20.0).abs() < 1e-9,
                    "got {}",
                    intent.size_shares
                );
            }
            other => panic!("expected Copy, got {other:?}"),
        }
    }

    #[test]
    fn keeps_size_below_cap_unchanged() {
        // 35 shares × 0.5 = $17.50, > $10 cap → capped at 20 shares
        let t = trade("btc-updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &cfg(), &empty_positions("h"), None, Utc::now());
        match d {
            Decision::Copy(intent) => {
                assert!((intent.size_shares - 20.0).abs() < 1e-9);
            }
            other => panic!("expected Copy, got {other:?}"),
        }
    }

    #[test]
    fn copy_ratio_half_halves_target_size() {
        let mut c = cfg();
        c.copy_ratio = 0.5;
        // master 35 shares × 0.5 ratio = 17.5 shares target.
        // 17.5 × 0.5 = $8.75 cost < $10 cap → no capping, use 17.5.
        let t = trade("btc-updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &c, &empty_positions("ratio_half"), None, Utc::now());
        match d {
            Decision::Copy(intent) => {
                assert!((intent.size_shares - 17.5).abs() < 1e-9);
            }
            other => panic!("expected Copy, got {other:?}"),
        }
    }

    #[test]
    fn copy_ratio_zero_results_in_zero_target() {
        let mut c = cfg();
        c.copy_ratio = 0.0;
        let t = trade("btc-updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &c, &empty_positions("ratio_zero"), None, Utc::now());
        // Classifier returns Copy with 0 shares; executor will reject as NoLiquidity.
        // We test that no panic and the size is zero.
        match d {
            Decision::Copy(intent) => assert_eq!(intent.size_shares, 0.0),
            other => panic!("expected Copy(0 shares), got {other:?}"),
        }
    }

    #[test]
    fn tiny_master_price_does_not_divide_by_zero() {
        let t = TradeView {
            price: 0.0001,
            size_shares: 1.0,
            ..trade("btc-updown-5m-1779028200", Side::Buy)
        };
        let d = classify(&t, &cfg(), &empty_positions("tiny"), None, Utc::now());
        // 1 × 0.0001 = $0.0001 cost < $10 cap → keep size = 1
        match d {
            Decision::Copy(intent) => assert!((intent.size_shares - 1.0).abs() < 1e-9),
            other => panic!("expected Copy, got {other:?}"),
        }
    }

    #[test]
    fn zero_price_does_not_panic() {
        let t = TradeView {
            price: 0.0,
            size_shares: 1.0,
            ..trade("btc-updown-5m-1779028200", Side::Buy)
        };
        // Cost would be 0; classifier should not divide-by-zero on capping branch
        // (which only triggers when cost > cap; 0 is not > 10, so no cap).
        let d = classify(&t, &cfg(), &empty_positions("zero_price"), None, Utc::now());
        assert!(matches!(d, Decision::Copy(_)));
    }

    #[test]
    fn very_large_master_fill_caps_to_max_position() {
        let t = TradeView {
            size_shares: 1_000_000.0,
            price: 0.5,
            ..trade("btc-updown-5m-1779028200", Side::Buy)
        };
        let d = classify(&t, &cfg(), &empty_positions("huge"), None, Utc::now());
        match d {
            Decision::Copy(intent) => {
                // 10 / 0.5 = 20 shares
                assert!((intent.size_shares - 20.0).abs() < 1e-9);
            }
            other => panic!("expected Copy, got {other:?}"),
        }
    }

    #[test]
    fn max_open_positions_zero_always_blocks() {
        let mut c = cfg();
        c.max_open_positions = 0;
        let t = trade("btc-updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &c, &empty_positions("zero_cap"), None, Utc::now());
        assert!(matches!(d, Decision::Skip(SkipReason::OpenPositionsCap)));
    }

    #[test]
    fn mixed_case_slug_is_normalised() {
        // Uppercase prefix + valid epoch — accepted.
        let t = trade("BTC-Updown-5m-1779028200", Side::Buy);
        let d = classify(&t, &cfg(), &empty_positions("case"), None, Utc::now());
        assert!(matches!(d, Decision::Copy(_)));
    }

    #[test]
    fn empty_slug_is_rejected() {
        let t = trade("", Side::Buy);
        let d = classify(&t, &cfg(), &empty_positions("empty"), None, Utc::now());
        assert!(matches!(d, Decision::Skip(SkipReason::NotBitcoinFiveMin)));
    }

    #[test]
    fn parse_resolve_ts_for_btc_updown_5m_slug() {
        // epoch 1779028200 → 2026-05-15T15:50:00Z; resolve = +300s
        let r = parse_resolve_ts("btc-updown-5m-1779028200").unwrap();
        assert_eq!(r.timestamp(), 1779028500);
    }

    #[test]
    fn parse_resolve_ts_handles_suffix() {
        // Defensive: future schemas might append trailing tokens.
        let r = parse_resolve_ts("btc-updown-5m-1779028200-foo").unwrap();
        assert_eq!(r.timestamp(), 1779028500);
    }

    #[test]
    fn parse_resolve_ts_returns_none_for_bitcoin_up_or_down_slug() {
        assert!(parse_resolve_ts("bitcoin-up-or-down-may-17-2026-2pm-et").is_none());
    }

    #[test]
    fn parse_resolve_ts_returns_none_for_garbage() {
        assert!(parse_resolve_ts("trump-2028-winner").is_none());
        assert!(parse_resolve_ts("btc-updown-5m-").is_none());
        assert!(parse_resolve_ts("btc-updown-5m-notanepoch").is_none());
    }

    #[test]
    fn open_positions_cap_blocks() {
        let mut pos = empty_positions("i");
        for i in 0..10 {
            pos.open(super::super::positions::OpenPosition {
                market_id: format!("0xmkt-{i}"),
                token_id: "x".into(),
                side: "buy".into(),
                size_shares: 1.0,
                entry_price: 0.5,
                opened_at: Utc::now(),
                market_slug: "btc-updown-5m-1779028200".into(),
            })
            .unwrap();
        }
        let t = trade("btc-updown-5m-1779028500", Side::Buy);
        let d = classify(&t, &cfg(), &pos, None, Utc::now());
        assert!(matches!(d, Decision::Skip(SkipReason::OpenPositionsCap)));
    }
}
