use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const BONEREAPER: &str = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";

fn default_master_address() -> String {
    BONEREAPER.to_string()
}
fn default_copy_ratio() -> f64 {
    1.0
}
fn default_max_position_usdc() -> f64 {
    10.0
}
fn default_max_open_positions() -> usize {
    10
}
fn default_daily_loss_cap_pct() -> f64 {
    5.0
}
fn default_spread_skip_cents() -> u32 {
    2
}
fn default_min_time_to_resolve_secs() -> i64 {
    60
}
fn default_poll_interval_secs() -> u64 {
    2
}
fn default_ledger_path() -> String {
    "data/bot-ledger.jsonl".to_string()
}
fn default_positions_path() -> String {
    "data/bot-positions.json".to_string()
}
fn default_kill_switch_path() -> String {
    "data/bot-killed".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BotConfig {
    #[serde(default = "default_master_address")]
    pub master_address: String,
    #[serde(default = "default_copy_ratio")]
    pub copy_ratio: f64,
    #[serde(default = "default_max_position_usdc")]
    pub max_position_usdc: f64,
    #[serde(default = "default_max_open_positions")]
    pub max_open_positions: usize,
    #[serde(default = "default_daily_loss_cap_pct")]
    pub daily_loss_cap_pct: f64,
    #[serde(default = "default_spread_skip_cents")]
    pub spread_skip_cents: u32,
    #[serde(default = "default_min_time_to_resolve_secs")]
    pub min_time_to_resolve_secs: i64,
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    #[serde(default = "default_ledger_path")]
    pub ledger_path: String,
    #[serde(default = "default_positions_path")]
    pub positions_path: String,
    #[serde(default = "default_kill_switch_path")]
    pub kill_switch_path: String,
}

impl Default for BotConfig {
    fn default() -> Self {
        serde_json::from_str("{}").expect("empty object parses with serde defaults")
    }
}

impl BotConfig {
    pub fn load(explicit_path: Option<&str>) -> Result<Self> {
        let path = match explicit_path {
            Some(p) => PathBuf::from(p),
            None => default_path()?,
        };
        match fs::read_to_string(&path) {
            Ok(data) => serde_json::from_str(&data)
                .with_context(|| format!("invalid JSON in bot config {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => {
                Err(anyhow::anyhow!(e)
                    .context(format!("failed to read bot config {}", path.display())))
            }
        }
    }
}

fn default_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not determine home directory")?;
    Ok(home.join(".config").join("polymarket").join("bot.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_json_parses_to_defaults() {
        let cfg: BotConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg.master_address, BONEREAPER);
        assert_eq!(cfg.copy_ratio, 1.0);
        assert_eq!(cfg.max_position_usdc, 10.0);
        assert_eq!(cfg.max_open_positions, 10);
        assert_eq!(cfg.poll_interval_secs, 2);
        assert_eq!(cfg.min_time_to_resolve_secs, 60);
        assert_eq!(cfg.spread_skip_cents, 2);
    }

    #[test]
    fn partial_override_keeps_other_defaults() {
        let cfg: BotConfig =
            serde_json::from_str(r#"{"max_position_usdc": 25.0, "copy_ratio": 0.5}"#).unwrap();
        assert_eq!(cfg.max_position_usdc, 25.0);
        assert_eq!(cfg.copy_ratio, 0.5);
        assert_eq!(cfg.max_open_positions, 10); // unchanged
        assert_eq!(cfg.master_address, BONEREAPER); // unchanged
    }

    #[test]
    fn rejects_invalid_json() {
        let r: Result<BotConfig, _> = serde_json::from_str("{not json");
        assert!(r.is_err());
    }

    #[test]
    fn round_trip_serializes_all_fields() {
        let cfg = BotConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        let parsed: BotConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.master_address, cfg.master_address);
        assert_eq!(parsed.poll_interval_secs, cfg.poll_interval_secs);
    }
}
