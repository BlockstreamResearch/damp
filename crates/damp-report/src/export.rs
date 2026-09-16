//! Gather public issuer transactions before the issuer performs an offline export.
use crate::{config::Config, provider::Chain, report::scope};
use anyhow::{Context, ensure};
use damp_core::registry::DeploymentManifest;
use damp_indexer::{Budget, HistoryIndex, Outpoint, Snapshot};
use serde_json::json;
use std::{
    fs,
    io::Write,
    ops::ControlFlow,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
};

pub fn prepare(
    config: &Config,
    deployment: DeploymentManifest,
    directory: &Path,
) -> anyhow::Result<()> {
    ensure!(!directory.exists(), "choose a new export directory");
    let manifest = serde_json::to_value(&deployment)?;
    let mut chain = Chain::new(config.provider.clone(), deployment.network())?;
    ensure!(
        chain.readiness()?["ready"] == true,
        "provider is not ready; wait for archival chain and txindex synchronization"
    );
    let genesis: Outpoint = manifest["genesisAnchor"]
        .as_str()
        .context("genesis anchor missing")?
        .parse()?;
    let start = chain.status(genesis.txid())?;
    let tip = chain.height()?;
    let hash = chain.hash(tip)?;
    let snapshot = Snapshot::new(start, (tip, hash), (tip, hash))?;
    let scope = scope(&deployment, &chain)?;
    let mut index = HistoryIndex::open(
        &config.index_dir,
        &scope,
        config.index_max_mib * 1024 * 1024,
    )?;
    index.scan(&mut chain, &snapshot, Budget::default(), |p| {
        eprintln!("{}", serde_json::to_string(&p)?);
        Ok(ControlFlow::Continue(()))
    })?;
    let view = index.view(tip);
    let mut cursor = None;
    let mut transactions = Vec::new();
    let mut size = 0;
    while let Some((position, tx)) = view.next(cursor)? {
        cursor = Some(position);
        let v = serde_json::to_value(&tx)?;
        let issuer = v["txid"] == genesis.txid().to_string()
            || v["inputs"]
                .as_array()
                .context("missing inputs")?
                .iter()
                .any(|i| i["issuance"]["asset"] == manifest["regulatedAsset"]);
        if !issuer {
            continue;
        }
        let raw = view
            .raw(tx.transaction().txid)?
            .context("indexed transaction missing")?;
        size += raw.len();
        ensure!(
            size <= 24 * 1024 * 1024 && transactions.len() < 1024,
            "issuer export exceeds 24 MiB or 1024 transaction allowance"
        );
        transactions.push((
            v["txid"]
                .as_str()
                .context("transaction ID missing")?
                .to_owned(),
            raw,
        ));
    }
    index.assert_snapshot(&mut chain, &snapshot)?;
    fs::DirBuilder::new().mode(0o700).create(directory)?;
    let write = |name: &str, bytes: &[u8]| -> anyhow::Result<()> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.join(name))?
            .write_all(bytes)?;
        Ok(())
    };
    for (id, raw) in &transactions {
        write(&format!("{id}.hex"), raw.as_bytes())?;
    }
    let raw: Vec<_> = transactions.iter().map(|(_, raw)| raw).collect();
    write(
        "request.json",
        &serde_json::to_vec(&json!({"deployment":manifest,"issuerTransactions":raw}))?,
    )?;
    println!(
        "Wrote request.json and {} public transaction hex files. Use request.json for offline CLI export, or select the hex files in the browser's credential export. No wallet or audit secrets were accessed.",
        transactions.len()
    );
    Ok(())
}
