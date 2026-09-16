use anyhow::{Context, ensure};
use damp_report::{
    config::{Config, ProviderConfig},
    server::Service,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
};

fn private_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)?;
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("damp-report: {e}");
        std::process::exit(1);
    }
}
fn run() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("init") if args.len() == 2 => {
            let dir = Path::new(&args[1]);
            fs::DirBuilder::new()
                .mode(0o700)
                .create(dir)
                .context("choose a new service directory")?;
            damp_indexer::token::generate(
                &dir.join("access-token"),
                damp_indexer::token::TokenAction::Create,
            )?;
            let config = Config {
                credentials: "audit-credentials.json".into(),
                token: "access-token".into(),
                index_dir: "history".into(),
                port: 8778,
                origin: "http://127.0.0.1:5173".into(),
                provider: ProviderConfig::Esplora {
                    url: "https://blockstream.info/liquidtestnet/api".into(),
                },
                index_max_mib: 10240,
            };
            private_write(
                &dir.join("config.json"),
                &serde_json::to_vec_pretty(&config)?,
            )?;
            println!(
                "Created private config and access token. In Report, select a deployment, connect its issuer signer and download audit credentials. Run damp-report import-credentials CONFIG_FILE DOWNLOAD_FILE, then damp-report serve CONFIG_FILE. No provider is running yet."
            );
        }
        Some("import-credentials") if args.len() == 3 => {
            let config = Config::load(Path::new(&args[1]))?;
            damp_report::credential_import::import(&config, Path::new(&args[2]))?;
            println!(
                "Validated and installed restricted credentials with mode 600. Delete the original download and extra copies, then run damp-report serve CONFIG_FILE. The recovery phrase and spending keys were not imported."
            );
        }
        Some("health") if args.len() == 2 => {
            let config = Config::load(Path::new(&args[1]))?;
            let token = damp_report::config::token(&config.token)?;
            let response = reqwest::blocking::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(10))
                .build()?
                .get(format!("http://127.0.0.1:{}/health", config.port))
                .bearer_auth(token.as_str())
                .send()
                .map_err(|_| {
                    anyhow::anyhow!("service unreachable; start damp-report serve with this config")
                })?;
            ensure!(
                response.status().is_success(),
                "health request rejected; check the current token and configured port"
            );
            let mut body = String::new();
            response.take(1024 * 1024 + 1).read_to_string(&mut body)?;
            ensure!(body.len() <= 1024 * 1024, "health response too large");
            let value: Value = serde_json::from_str(&body)?;
            println!("{}", serde_json::to_string_pretty(&value)?);
        }
        Some("prepare-export") if args.len() == 4 => {
            let config = Config::load(Path::new(&args[1]))?;
            let manifest = serde_json::from_slice(&fs::read(&args[2])?)?;
            damp_report::export::prepare(&config, manifest, Path::new(&args[3]))?;
        }
        Some("export-request") if args.len() >= 2 => {
            let deployment: Value = serde_json::from_slice(&fs::read(&args[1])?)?;
            let _: damp_core::registry::DeploymentManifest =
                serde_json::from_value(deployment.clone())?;
            ensure!(args.len() <= 1026, "at most 1024 issuer transaction files");
            let mut transactions = Vec::new();
            let mut size = 0;
            for path in &args[2..] {
                let mut raw = String::new();
                fs::File::open(path)?
                    .take(8_000_001)
                    .read_to_string(&mut raw)?;
                size += raw.len();
                ensure!(
                    raw.len() <= 8_000_000 && size <= 24 * 1024 * 1024,
                    "issuer transaction files exceed allowance"
                );
                let _: damp_signer::transaction::TransactionRecord = raw.trim().parse()?;
                transactions.push(raw.trim().to_owned());
            }
            println!(
                "{}",
                json!({"deployment":deployment,"issuerTransactions":transactions})
            );
        }
        Some("verify") if args.len() == 3 => {
            let manifest: damp_core::registry::DeploymentManifest =
                serde_json::from_slice(&fs::read(&args[1])?)?;
            let mut bytes = Vec::new();
            fs::File::open(&args[2])?
                .take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 16 * 1024 * 1024, "report file too large");
            let signed: Value = serde_json::from_slice(&bytes)?;
            let sig = &signed["signature"];
            let cert_text = sig["certificateJson"]
                .as_str()
                .context("certificate missing")?;
            damp_signer::audit::verify_report(
                cert_text,
                &sig["certificateSignature"]
                    .as_str()
                    .context("certificate signature missing")?
                    .parse()?,
                manifest.issuer_public_key(),
            )?;
            let cert: Value = serde_json::from_str(cert_text)?;
            ensure!(
                cert["schema"] == "damp-audit-report-authorization/v1"
                    && cert["deploymentId"] == manifest.deployment_id().to_string()
                    && cert["network"] == manifest.network().as_str()
                    && cert["issuerPublicKey"] == manifest.issuer_public_key().to_string()
                    && cert["auditPublicKey"] == manifest.audit().public_key.to_string()
                    && cert["reportPublicKey"] == sig["publicKey"],
                "certificate scope mismatch"
            );
            let report_text = signed["reportJson"]
                .as_str()
                .context("report JSON missing")?;
            damp_signer::audit::verify_report(
                report_text,
                &sig["signature"]
                    .as_str()
                    .context("report signature missing")?
                    .parse()?,
                sig["publicKey"]
                    .as_str()
                    .context("report key missing")?
                    .parse()?,
            )?;
            let report: Value = serde_json::from_str(report_text)?;
            ensure!(
                report["schema"] == "damp-audit-report/v2"
                    && report["deploymentId"] == manifest.deployment_id().to_string()
                    && report["network"] == manifest.network().as_str(),
                "report scope mismatch"
            );
            println!(
                "{}",
                json!({"signaturesVerified":true,"complete":report["complete"],"throughHeight":report["throughHeight"],"supply":report["supply"],"gaps":report["gaps"]})
            );
        }
        Some("serve") if args.len() == 2 => {
            let mut config = Config::load(Path::new(&args[1]))?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,config.port)).await.context("cannot bind loopback port; choose an unused port in config")?;
                config.port = listener.local_addr()?.port();
                let port = config.port;
                let service = Service::new(config)?;
                let maintenance = tokio::spawn(service.clone().maintain());
                println!("damp-report listening at http://127.0.0.1:{port}/report; authenticated GET /health checks configuration. Provider and snapshot readiness are checked when a report starts.");
                let shutdown_service = service.clone();
                let result = axum::serve(listener,service.router()).with_graceful_shutdown(async move { let _ = tokio::signal::ctrl_c().await; shutdown_service.shutdown(); }).await;
                maintenance.abort(); service.shutdown(); result.context("report HTTP server stopped unexpectedly")
            })?;
        }
        _ => anyhow::bail!(
            "usage: damp-report init DIRECTORY | import-credentials CONFIG_FILE DOWNLOAD_FILE | serve CONFIG_FILE | health CONFIG_FILE | prepare-export CONFIG_FILE DEPLOYMENT_JSON NEW_DIRECTORY | export-request DEPLOYMENT_JSON [ISSUER_TX_HEX_FILE ...] | verify DEPLOYMENT_JSON SIGNED_REPORT_JSON"
        ),
    }
    Ok(())
}
