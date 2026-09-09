//! Local SDK runner; only Elements regtest and Liquid testnet are supported.
use anyhow::Context;
use simplicity_damp_signer::network::DeploymentNetwork;
use simplicity_damp_signer::wire::{
    execute_audit_credentials, execute_native, export_audit_credentials_json,
};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    anyhow::ensure!(
        args.len() >= 2,
        "usage: damp-audit new-wallet WALLET_FILE | OPERATION WALLET_FILE NETWORK < request.json"
    );
    let path = PathBuf::from(&args[1]);
    if args[0] == "new-wallet" {
        let (_, mnemonic) = lwk_signer::SwSigner::random(false)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&path)?
            .write_all(mnemonic.to_string().as_bytes())?;
        println!("{{\"created\":true}}");
        return Ok(());
    }
    anyhow::ensure!(args.len() == 3, "network is required");
    let network = match args[2].as_str() {
        "elements-regtest" => DeploymentNetwork::ElementsRegtest,
        "liquid-testnet" => DeploymentNetwork::LiquidTestnet,
        _ => anyhow::bail!("only regtest and Liquid testnet are supported"),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        anyhow::ensure!(
            fs::metadata(&path)?.permissions().mode() & 0o077 == 0,
            "wallet file must be owner-only"
        );
    }
    let mnemonic =
        zeroize::Zeroizing::new(fs::read_to_string(&path).context("read private wallet file")?);
    let mut input = String::new();
    std::io::stdin()
        .take(32 * 1024 * 1024)
        .read_to_string(&mut input)?;
    let request = serde_json::from_str(&input)?;
    if args[0] == "export-audit-credentials" {
        anyhow::ensure!(
            !mnemonic.trim_start().starts_with('{'),
            "export requires the offline issuer mnemonic"
        );
        let serialized = export_audit_credentials_json(mnemonic.trim(), network, request)?;
        std::io::stdout().write_all(serialized.as_bytes())?;
        println!();
        return Ok(());
    }
    let result = if mnemonic.trim_start().starts_with('{') {
        execute_audit_credentials(&mnemonic, network, &args[0], request)?
    } else {
        execute_native(mnemonic.trim(), network, &args[0], request)?
    };
    serde_json::to_writer(std::io::stdout(), &result)?;
    println!();
    Ok(())
}
