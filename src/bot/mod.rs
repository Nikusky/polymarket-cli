use anyhow::Result;
use clap::{Args, Subcommand};

use crate::output::OutputFormat;

pub(crate) mod classifier;
pub(crate) mod config;
pub(crate) mod executor;
pub(crate) mod ledger;
pub(crate) mod positions;
pub(crate) mod resolver;
pub(crate) mod watcher;

#[derive(Args)]
pub struct BotArgs {
    #[command(subcommand)]
    command: BotCommand,
}

#[derive(Subcommand)]
enum BotCommand {
    /// Run paper-trading against live data
    Paper {
        /// Starting paper bank in USDC
        #[arg(long, default_value = "500")]
        bank: f64,
        /// Path to bot config JSON (defaults to ~/.config/polymarket/bot.json)
        #[arg(long)]
        config: Option<String>,
    },
    /// Show open positions and today's PnL
    Status,
    /// Stop the running bot (writes a kill-switch file)
    Kill,
}

pub async fn execute(args: BotArgs, _output: OutputFormat) -> Result<()> {
    match args.command {
        BotCommand::Paper { bank, config: cfg } => watcher::run_paper(bank, cfg.as_deref()).await,
        BotCommand::Status => watcher::print_status(),
        BotCommand::Kill => watcher::request_kill(),
    }
}
