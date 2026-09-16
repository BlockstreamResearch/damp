//! Disposable public-provider fixture for reproducible HTTP/browser checks. No broadcast.
#[path = "../tests/support/mod.rs"]
mod support;
use damp_report::config::{Config, ProviderConfig};
use serde_json::json;
use std::{fs, os::unix::fs::DirBuilderExt, path::Path, time::Duration};
use support::*;
fn main() -> anyhow::Result<()> {
    let directory = std::env::args().nth(1).ok_or_else(|| {
        anyhow::anyhow!("usage: cargo run -p damp-report --example synthetic -- NEW_DIRECTORY")
    })?;
    let dir = Path::new(&directory);
    fs::DirBuilder::new().mode(0o700).create(dir)?;
    let fixture = fixture()?;
    let rpc = Rpc::start(fixture.clone());
    let public_transactions: Vec<_> = fixture
        .transactions
        .iter()
        .map(|raw| {
            raw.parse::<damp_signer::transaction::TransactionRecord>()
                .map(|tx| tx.inspect_public())
        })
        .collect::<Result<_, _>>()?;
    private(
        &dir.join("fixture.json"),
        &serde_json::to_vec(
            &json!({"request":fixture.request,"mnemonic":MNEMONIC,"transactions":fixture.transactions,"publicTransactions":public_transactions}),
        )?,
    );
    private(
        &dir.join("deployment.json"),
        &serde_json::to_vec(&fixture.request["deployment"])?,
    );
    private(&dir.join("issuer-wallet"), MNEMONIC.as_bytes());
    private(&dir.join("cookie"), b"fixture:cookie");
    damp_indexer::token::generate(
        &dir.join("access-token"),
        damp_indexer::token::TokenAction::Create,
    )?;
    let config = Config {
        credentials: "audit-credentials.json".into(),
        token: "access-token".into(),
        index_dir: "history".into(),
        port: 18778,
        origin: "http://127.0.0.1:5173".into(),
        provider: ProviderConfig::Rpc {
            port: rpc.port,
            cookie: "cookie".into(),
        },
        index_max_mib: 32,
    };
    private(
        &dir.join("config.json"),
        &serde_json::to_vec_pretty(&config)?,
    );
    println!(
        "Synthetic RPC listening at 127.0.0.1:{}. Fixture directory ready. Run prepare-export, then export the disposable credentials and start damp-report. Ctrl-C stops this fixture.",
        rpc.port
    );
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
