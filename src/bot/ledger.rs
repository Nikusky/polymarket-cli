use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LedgerRecord {
    PaperEntry {
        ts: DateTime<Utc>,
        tx_hash: String,
        market_id: String,
        token_id: String,
        side: String,
        size_shares: f64,
        price: f64,
        cost_usdc: f64,
        master_size_shares: f64,
        market_slug: String,
    },
    PaperExit {
        ts: DateTime<Utc>,
        market_id: String,
        token_id: String,
        size_shares: f64,
        payout_per_share: f64,
        proceeds_usdc: f64,
        realized_pnl_usdc: f64,
    },
    Skip {
        ts: DateTime<Utc>,
        tx_hash: String,
        reason: String,
        detail: Option<String>,
    },
    Heartbeat {
        ts: DateTime<Utc>,
        open_positions: usize,
        bank_remaining_usdc: f64,
        seen_trades: u64,
    },
    Error {
        ts: DateTime<Utc>,
        detail: String,
    },
}

impl LedgerRecord {
    pub fn ts(&self) -> DateTime<Utc> {
        match self {
            Self::PaperEntry { ts, .. }
            | Self::PaperExit { ts, .. }
            | Self::Skip { ts, .. }
            | Self::Heartbeat { ts, .. }
            | Self::Error { ts, .. } => *ts,
        }
    }
}

pub struct Ledger {
    path: PathBuf,
    file: File,
}

impl Ledger {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create ledger dir {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("failed to open ledger {}", path.display()))?;
        Ok(Self { path, file })
    }

    pub fn append(&mut self, record: &LedgerRecord) -> Result<()> {
        let mut line = serde_json::to_string(record).context("failed to serialize record")?;
        line.push('\n');
        self.file
            .write_all(line.as_bytes())
            .with_context(|| format!("failed to append to {}", self.path.display()))?;
        Ok(())
    }

    pub fn read_all(path: impl AsRef<Path>) -> Result<Vec<LedgerRecord>> {
        let path = path.as_ref();
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(
                    anyhow::anyhow!(e).context(format!("failed to read ledger {}", path.display()))
                );
            }
        };
        let mut out = Vec::new();
        for (i, line) in BufReader::new(file).lines().enumerate() {
            let line = line.context("read line")?;
            if line.trim().is_empty() {
                continue;
            }
            let rec: LedgerRecord = serde_json::from_str(&line)
                .with_context(|| format!("ledger line {} not valid JSON", i + 1))?;
            out.push(rec);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_path(name: &str) -> PathBuf {
        let pid = std::process::id();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        env::temp_dir().join(format!("ledger-{name}-{pid}-{nonce}.jsonl"))
    }

    #[test]
    fn round_trip_paper_entry() {
        let path = tmp_path("entry");
        let mut led = Ledger::open(&path).unwrap();
        let rec = LedgerRecord::PaperEntry {
            ts: Utc::now(),
            tx_hash: "0xabc".into(),
            market_id: "0xmkt".into(),
            token_id: "12345".into(),
            side: "buy".into(),
            size_shares: 20.0,
            price: 0.5,
            cost_usdc: 10.0,
            master_size_shares: 35.0,
            market_slug: "bitcoin-up-or-down-12345".into(),
        };
        led.append(&rec).unwrap();
        drop(led);

        let all = Ledger::read_all(&path).unwrap();
        assert_eq!(all.len(), 1);
        match &all[0] {
            LedgerRecord::PaperEntry {
                tx_hash, cost_usdc, ..
            } => {
                assert_eq!(tx_hash, "0xabc");
                assert!((cost_usdc - 10.0).abs() < 1e-9);
            }
            other => panic!("wrong variant: {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn append_multiple_records_then_read() {
        let path = tmp_path("multi");
        let mut led = Ledger::open(&path).unwrap();
        led.append(&LedgerRecord::Heartbeat {
            ts: Utc::now(),
            open_positions: 0,
            bank_remaining_usdc: 500.0,
            seen_trades: 0,
        })
        .unwrap();
        led.append(&LedgerRecord::Skip {
            ts: Utc::now(),
            tx_hash: "0xdef".into(),
            reason: "spread_too_wide".into(),
            detail: Some("3 cents".into()),
        })
        .unwrap();
        led.append(&LedgerRecord::Error {
            ts: Utc::now(),
            detail: "rpc timeout".into(),
        })
        .unwrap();
        drop(led);

        let all = Ledger::read_all(&path).unwrap();
        assert_eq!(all.len(), 3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_missing_file_returns_empty() {
        let path = tmp_path("missing");
        let all = Ledger::read_all(&path).unwrap();
        assert!(all.is_empty());
    }
}
