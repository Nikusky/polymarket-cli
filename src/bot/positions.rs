use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenPosition {
    pub market_id: String,
    pub token_id: String,
    pub side: String,
    pub size_shares: f64,
    pub entry_price: f64,
    pub opened_at: DateTime<Utc>,
    pub market_slug: String,
}

#[derive(Debug)]
pub struct Positions {
    path: PathBuf,
    map: HashMap<String, OpenPosition>,
}

impl Positions {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let map = match fs::read_to_string(&path) {
            Ok(data) if data.trim().is_empty() => HashMap::new(),
            Ok(data) => serde_json::from_str(&data)
                .with_context(|| format!("invalid positions JSON at {}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => {
                return Err(anyhow::anyhow!(e)
                    .context(format!("failed to read positions {}", path.display())));
            }
        };
        Ok(Self { path, map })
    }

    pub fn is_open(&self, market_id: &str) -> bool {
        self.map.contains_key(market_id)
    }

    pub fn count(&self) -> usize {
        self.map.len()
    }

    pub fn all(&self) -> impl Iterator<Item = &OpenPosition> {
        self.map.values()
    }

    pub fn open(&mut self, pos: OpenPosition) -> Result<()> {
        self.map.insert(pos.market_id.clone(), pos);
        self.save()
    }

    pub fn remove(&mut self, market_id: &str) -> Result<Option<OpenPosition>> {
        let removed = self.map.remove(market_id);
        if removed.is_some() {
            self.save()?;
        }
        Ok(removed)
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create dir {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(&self.map)?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).with_context(|| format!("failed to write {}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("failed to rename to {}", self.path.display()))?;
        Ok(())
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
        env::temp_dir().join(format!("positions-{name}-{pid}-{nonce}.json"))
    }

    fn sample(market: &str) -> OpenPosition {
        OpenPosition {
            market_id: market.into(),
            token_id: "12345".into(),
            side: "buy".into(),
            size_shares: 20.0,
            entry_price: 0.5,
            opened_at: Utc::now(),
            market_slug: "bitcoin-up-or-down-x".into(),
        }
    }

    #[test]
    fn load_missing_is_empty() {
        let p = tmp_path("missing");
        let pos = Positions::load(&p).unwrap();
        assert_eq!(pos.count(), 0);
        assert!(!pos.is_open("anything"));
    }

    #[test]
    fn open_then_persisted() {
        let p = tmp_path("open");
        let mut pos = Positions::load(&p).unwrap();
        pos.open(sample("0xmkt-a")).unwrap();
        assert!(pos.is_open("0xmkt-a"));
        assert_eq!(pos.count(), 1);
        drop(pos);

        let reload = Positions::load(&p).unwrap();
        assert!(reload.is_open("0xmkt-a"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn remove_decrements_and_persists() {
        let p = tmp_path("remove");
        let mut pos = Positions::load(&p).unwrap();
        pos.open(sample("0xmkt-a")).unwrap();
        pos.open(sample("0xmkt-b")).unwrap();
        assert_eq!(pos.count(), 2);

        let removed = pos.remove("0xmkt-a").unwrap();
        assert!(removed.is_some());
        assert_eq!(pos.count(), 1);
        assert!(!pos.is_open("0xmkt-a"));
        assert!(pos.is_open("0xmkt-b"));

        let reload = Positions::load(&p).unwrap();
        assert_eq!(reload.count(), 1);
        let _ = std::fs::remove_file(&p);
    }
}
