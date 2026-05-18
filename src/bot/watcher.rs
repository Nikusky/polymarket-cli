use std::collections::HashSet;
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use polymarket_client_sdk::data::Client as DataClient;
use polymarket_client_sdk::data::types::Side as SdkSide;
use polymarket_client_sdk::data::types::request::TradesRequest;
use polymarket_client_sdk::data::types::response::Trade;
use polymarket_client_sdk::gamma::Client as GammaClient;
use polymarket_client_sdk::gamma::types::request::MarketBySlugRequest;
use polymarket_client_sdk::types::Address;
use rust_decimal::prelude::ToPrimitive;
use tokio::time::{Instant, sleep};

use super::classifier::{Decision, Side, SkipReason, TradeView, classify, parse_resolve_ts};
use super::config::BotConfig;
use super::executor::{ExecOutcome, PaperExecutor};
use super::ledger::{Ledger, LedgerRecord};
use super::positions::{OpenPosition, Positions};
use super::resolver::settle;

const TRADE_LIMIT: i32 = 100;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const SETTLE_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default, Debug)]
struct LiveStats {
    entries: u32,
    exits: u32,
    wins: u32,
    skips: u32,
}

pub async fn run_paper(bank: f64, config_path: Option<&str>) -> Result<()> {
    let cfg = BotConfig::load(config_path)?;
    println!(
        "[bot] paper mode | bank=${bank:.2} master={} poll={}s cap=${:.2} max_open={} loss_cap={:.1}%",
        cfg.master_address,
        cfg.poll_interval_secs,
        cfg.max_position_usdc,
        cfg.max_open_positions,
        cfg.daily_loss_cap_pct
    );

    if Path::new(&cfg.kill_switch_path).exists() {
        anyhow::bail!(
            "kill-switch file present at {}; remove it before running",
            cfg.kill_switch_path
        );
    }

    let starting_bank = bank;
    let loss_threshold = -(starting_bank * cfg.daily_loss_cap_pct / 100.0);

    let mut ledger = Ledger::open(&cfg.ledger_path)?;
    let mut positions = Positions::load(&cfg.positions_path)?;
    let mut executor = PaperExecutor::new(bank);

    let master = Address::from_str(&cfg.master_address)
        .with_context(|| format!("invalid master_address: {}", cfg.master_address))?;
    let data = DataClient::default();
    let gamma = GammaClient::default();

    let mut seen: HashSet<String> = HashSet::new();
    let mut seen_count: u64 = 0;
    let mut last_heartbeat = Instant::now() - HEARTBEAT_INTERVAL;
    let mut last_settle_sweep = Instant::now() - SETTLE_INTERVAL;
    let mut warmed_up = false;
    let mut realized_pnl_session: f64 = 0.0;
    let mut cap_hit = false;
    let mut stats = LiveStats::default();

    loop {
        if Path::new(&cfg.kill_switch_path).exists() {
            println!("[bot] kill switch detected → exiting");
            ledger.append(&LedgerRecord::Heartbeat {
                ts: Utc::now(),
                open_positions: positions.count(),
                bank_remaining_usdc: executor.bank_usdc,
                seen_trades: seen_count,
            })?;
            return Ok(());
        }

        let req = TradesRequest::builder()
            .user(master)
            .limit(TRADE_LIMIT)?
            .build();
        match data.trades(&req).await {
            Ok(trades) => {
                if !warmed_up {
                    for t in &trades {
                        seen.insert(format!("{:?}", t.transaction_hash));
                    }
                    seen_count = seen.len() as u64;
                    warmed_up = true;
                    println!("[bot] warmed up with {} historical fills", seen.len());
                } else {
                    let mut new_trades: Vec<&Trade> = trades
                        .iter()
                        .filter(|t| !seen.contains(&format!("{:?}", t.transaction_hash)))
                        .collect();
                    new_trades.sort_by_key(|t| t.timestamp);
                    let new_count = new_trades.len();
                    let entries_before = stats.entries;
                    let skips_before = stats.skips;
                    for t in new_trades {
                        let key = format!("{:?}", t.transaction_hash);
                        seen.insert(key);
                        seen_count += 1;
                        if let Err(e) = handle_new_trade(
                            t,
                            &cfg,
                            &mut ledger,
                            &mut positions,
                            &mut executor,
                            cap_hit,
                            &mut stats,
                        )
                        .await
                        {
                            let _ = ledger.append(&LedgerRecord::Error {
                                ts: Utc::now(),
                                detail: format!("handle_new_trade: {e:#}"),
                            });
                            eprintln!("[bot] error handling trade: {e:#}");
                        }
                    }
                    if new_count > 0 {
                        let new_fills = stats.entries - entries_before;
                        let new_skips = stats.skips - skips_before;
                        println!(
                            "[bot] tick {} | master fills={new_count} → bot fills={new_fills} skips={new_skips}",
                            Utc::now().format("%H:%M:%S")
                        );
                    }
                }
            }
            Err(e) => {
                let detail = format!("data.trades poll failed: {e:#}");
                eprintln!("[bot] {detail}");
                let _ = ledger.append(&LedgerRecord::Error {
                    ts: Utc::now(),
                    detail,
                });
            }
        }

        // Settlement sweep — fetch each open market, settle if resolved.
        if last_settle_sweep.elapsed() >= SETTLE_INTERVAL && positions.count() > 0 {
            let session_pnl_change = settle_open_positions(
                &gamma,
                &mut positions,
                &mut ledger,
                &mut executor,
                &mut stats,
            )
            .await;
            realized_pnl_session += session_pnl_change;
            if !cap_hit && realized_pnl_session < loss_threshold {
                cap_hit = true;
                let detail = format!(
                    "daily_loss_cap_hit pnl={realized_pnl_session:.2} threshold={loss_threshold:.2}"
                );
                eprintln!("[bot] DAILY LOSS CAP HIT — new fills will be skipped ({detail})");
                let _ = ledger.append(&LedgerRecord::Error {
                    ts: Utc::now(),
                    detail,
                });
            }
            last_settle_sweep = Instant::now();
        }

        if last_heartbeat.elapsed() >= HEARTBEAT_INTERVAL {
            ledger.append(&LedgerRecord::Heartbeat {
                ts: Utc::now(),
                open_positions: positions.count(),
                bank_remaining_usdc: executor.bank_usdc,
                seen_trades: seen_count,
            })?;
            let win_rate = if stats.exits > 0 {
                (stats.wins as f64 / stats.exits as f64) * 100.0
            } else {
                0.0
            };
            let pnl_marker = if realized_pnl_session > 0.0 { "+" } else { "" };
            let cap_marker = if cap_hit { "  [CAP HIT]" } else { "" };
            println!("──────────────────────────────────────────────────────────────────");
            println!(
                "[bot] heartbeat {}   open={}  bank=${:.2}  pnl={}${:.2}{}",
                Utc::now().format("%H:%M:%S"),
                positions.count(),
                executor.bank_usdc,
                pnl_marker,
                realized_pnl_session,
                cap_marker
            );
            println!(
                "      session: entries={} exits={} wins={} skips={} win_rate={:.1}%  seen={}",
                stats.entries, stats.exits, stats.wins, stats.skips, win_rate, seen_count
            );
            if positions.count() > 0 {
                let avg_age = positions
                    .all()
                    .map(|p| (Utc::now() - p.opened_at).num_seconds())
                    .sum::<i64>()
                    / positions.count() as i64;
                println!(
                    "      open positions avg age = {avg_age}s (settle sweep every {}s)",
                    SETTLE_INTERVAL.as_secs()
                );
            }
            println!("──────────────────────────────────────────────────────────────────");
            last_heartbeat = Instant::now();
        }

        sleep(Duration::from_secs(cfg.poll_interval_secs)).await;
    }
}

/// Iterate every open position; if its market is resolved, write a `PaperExit`
/// record, credit the bank, and remove from the positions store. Returns the
/// total realized PnL produced by this sweep (sum of `realized_pnl_usdc`).
async fn settle_open_positions(
    gamma: &GammaClient,
    positions: &mut Positions,
    ledger: &mut Ledger,
    executor: &mut PaperExecutor,
    stats: &mut LiveStats,
) -> f64 {
    let snapshot: Vec<OpenPosition> = positions.all().cloned().collect();
    let mut pnl_total = 0.0;

    for pos in snapshot {
        let req = MarketBySlugRequest::builder()
            .slug(pos.market_slug.clone())
            .build();
        let market = match gamma.market_by_slug(&req).await {
            Ok(m) => m,
            Err(e) => {
                eprintln!(
                    "[bot] settle: failed to fetch market_by_slug({}): {e:#}",
                    pos.market_slug
                );
                continue;
            }
        };

        let Some(settlement) = settle(&pos, &market) else {
            continue;
        };

        executor.bank_usdc += settlement.proceeds;
        pnl_total += settlement.realized_pnl;
        stats.exits += 1;
        if settlement.realized_pnl > 0.0 {
            stats.wins += 1;
        }

        let now = Utc::now();
        if let Err(e) = ledger.append(&LedgerRecord::PaperExit {
            ts: now,
            market_id: pos.market_id.clone(),
            token_id: pos.token_id.clone(),
            size_shares: pos.size_shares,
            payout_per_share: settlement.payout_per_share,
            proceeds_usdc: settlement.proceeds,
            realized_pnl_usdc: settlement.realized_pnl,
        }) {
            eprintln!("[bot] settle: failed to write ledger PaperExit: {e:#}");
            continue;
        }
        if let Err(e) = positions.remove(&pos.market_id) {
            eprintln!("[bot] settle: failed to remove position: {e:#}");
        }

        println!(
            "[bot] EXIT {} payout={:.2} proceeds=${:.2} pnl=${:.2}",
            pos.market_slug,
            settlement.payout_per_share,
            settlement.proceeds,
            settlement.realized_pnl
        );
    }
    pnl_total
}

async fn handle_new_trade(
    trade: &Trade,
    cfg: &BotConfig,
    ledger: &mut Ledger,
    positions: &mut Positions,
    executor: &mut PaperExecutor,
    cap_hit: bool,
    stats: &mut LiveStats,
) -> Result<()> {
    let view = trade_view(trade);
    let resolve_ts = parse_resolve_ts(&view.market_slug);
    let decision = classify(&view, cfg, positions, resolve_ts, Utc::now());
    match decision {
        Decision::Skip(reason) => {
            ledger.append(&LedgerRecord::Skip {
                ts: Utc::now(),
                tx_hash: view.tx_hash.clone(),
                reason: reason.as_str().to_string(),
                detail: None,
            })?;
            stats.skips += 1;
            if !matches!(reason, SkipReason::NotBitcoinFiveMin | SkipReason::NotBuy) {
                println!(
                    "[bot] skip {} on {} ({})",
                    reason.as_str(),
                    view.market_slug,
                    view.tx_hash
                );
            }
            Ok(())
        }
        Decision::Copy(intent) => {
            if cap_hit {
                ledger.append(&LedgerRecord::Skip {
                    ts: Utc::now(),
                    tx_hash: intent.tx_hash.clone(),
                    reason: "daily_loss_cap".to_string(),
                    detail: None,
                })?;
                stats.skips += 1;
                println!("[bot] skip daily_loss_cap on {}", intent.market_slug);
                return Ok(());
            }
            let outcome = executor.enter(&intent, cfg, ledger, positions).await?;
            match outcome {
                ExecOutcome::Filled {
                    shares,
                    price,
                    cost,
                } => {
                    stats.entries += 1;
                    println!(
                        "[bot] FILL {:.2} @ ${:.4} (${:.2}) on {}",
                        shares, price, cost, intent.market_slug
                    );
                }
                ExecOutcome::Skipped(reason) => {
                    ledger.append(&LedgerRecord::Skip {
                        ts: Utc::now(),
                        tx_hash: intent.tx_hash.clone(),
                        reason: reason.label().to_string(),
                        detail: reason.detail(),
                    })?;
                    stats.skips += 1;
                    println!("[bot] skip {} on {}", reason.label(), intent.market_slug);
                }
            }
            Ok(())
        }
    }
}

fn trade_view(trade: &Trade) -> TradeView {
    let side = match &trade.side {
        SdkSide::Buy => Side::Buy,
        _ => Side::Sell,
    };
    let timestamp = Utc
        .timestamp_opt(trade.timestamp, 0)
        .single()
        .unwrap_or_else(Utc::now);
    TradeView {
        tx_hash: format!("{:?}", trade.transaction_hash),
        market_id: format!("{:?}", trade.condition_id),
        token_id: trade.asset.to_string(),
        side,
        size_shares: trade.size.to_f64().unwrap_or(0.0),
        price: trade.price.to_f64().unwrap_or(0.0),
        timestamp,
        market_slug: trade.slug.clone(),
    }
}

pub fn request_kill() -> Result<()> {
    let cfg = BotConfig::load(None)?;
    if let Some(parent) = Path::new(&cfg.kill_switch_path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&cfg.kill_switch_path, b"killed\n")
        .with_context(|| format!("failed to write {}", cfg.kill_switch_path))?;
    println!("[bot] kill-switch written to {}", cfg.kill_switch_path);
    Ok(())
}

pub fn print_status() -> Result<()> {
    let cfg = BotConfig::load(None)?;
    let positions = Positions::load(&cfg.positions_path)?;
    let recs = Ledger::read_all(&cfg.ledger_path).unwrap_or_default();

    let today = Utc::now().date_naive();
    let mut today_entries = 0u32;
    let mut today_skips = 0u32;
    let mut today_exits = 0u32;
    let mut today_pnl = 0.0;
    let mut all_exits = 0u32;
    let mut all_pnl = 0.0;
    let mut all_wins = 0u32;
    let mut last_heartbeat: Option<(DateTime<Utc>, f64, u64)> = None;
    for r in &recs {
        let is_today = r.ts().date_naive() == today;
        match r {
            LedgerRecord::PaperEntry { .. } if is_today => today_entries += 1,
            LedgerRecord::Skip { .. } if is_today => today_skips += 1,
            LedgerRecord::PaperExit {
                realized_pnl_usdc, ..
            } => {
                all_exits += 1;
                all_pnl += realized_pnl_usdc;
                if *realized_pnl_usdc > 0.0 {
                    all_wins += 1;
                }
                if is_today {
                    today_exits += 1;
                    today_pnl += realized_pnl_usdc;
                }
            }
            LedgerRecord::Heartbeat {
                ts,
                bank_remaining_usdc,
                seen_trades,
                ..
            } => {
                last_heartbeat = Some((*ts, *bank_remaining_usdc, *seen_trades));
            }
            _ => {}
        }
    }
    let win_rate = if all_exits > 0 {
        (all_wins as f64 / all_exits as f64) * 100.0
    } else {
        0.0
    };

    println!("Bot status");
    println!("  Open positions:   {}", positions.count());
    println!("  Today entries:    {today_entries}");
    println!("  Today skips:      {today_skips}");
    println!("  Today exits:      {today_exits}  realized PnL ${today_pnl:.2}");
    println!(
        "  All-time exits:   {all_exits}  realized PnL ${all_pnl:.2}  win rate {win_rate:.1}%"
    );
    if let Some((ts, bank, seen)) = last_heartbeat {
        println!(
            "  Last heartbeat:   {} | bank=${bank:.2} seen={seen}",
            ts.to_rfc3339()
        );
    } else {
        println!("  Last heartbeat:   (none — bot has not run yet)");
    }
    if positions.count() > 0 {
        println!();
        println!("  Open markets:");
        for p in positions.all() {
            let age_secs = (Utc::now() - p.opened_at).num_seconds();
            println!(
                "    {} @ ${:.4} × {:.2} shares  age={}s  ({})",
                p.market_slug, p.entry_price, p.size_shares, age_secs, p.market_id
            );
        }
    }
    Ok(())
}
