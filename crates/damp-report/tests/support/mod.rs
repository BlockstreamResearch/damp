#![allow(dead_code)]
use damp_core::{
    ledger::ConsensusTxid,
    registry::{AssetMetadata, SupplyMode},
};
use damp_signer::{
    Signer,
    keys::{HolderKeyLocator, KeyIndex, WalletBranch, WalletKeyLocator},
    network::DeploymentNetwork,
    ops::request::{BootstrapRequest, TransferRequest},
    utxo::{InputSource, InputStatus, Ownership, Utxo},
    wire::export_audit_credentials_json,
};
use elements::{
    AssetId, LockTime, Script, Transaction, TxOut, TxOutWitness,
    confidential::{Asset, Nonce, Value as Amount},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

pub const MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
#[derive(Clone)]
pub struct Fixture {
    pub request: Value,
    pub credentials: String,
    pub transactions: Vec<String>,
    pub ids: Vec<String>,
}
pub fn fixture() -> anyhow::Result<Fixture> {
    let network = DeploymentNetwork::ElementsRegtest;
    let signer = Signer::new(MNEMONIC, network)?;
    let asset = AssetId::from_byte_array([0xaa; 32]);
    let mut bytes = asset.into_inner().to_byte_array();
    bytes.reverse();
    let mut funding = Vec::new();
    for index in 0..2u32 {
        let address = signer.wallet_address(WalletBranch::Receive, index.try_into()?)?;
        funding.push(Utxo::new(
            damp_core::ledger::Outpoint::new(ConsensusTxid::from([index as u8 + 1; 32]).into(), 0),
            InputSource::Output(TxOut {
                asset: Asset::Explicit(asset),
                value: Amount::Explicit(100_000),
                nonce: Nonce::Null,
                script_pubkey: Script::from(hex::decode(address.script_pubkey)?),
                witness: TxOutWitness::default(),
            }),
            Ownership::Wallet(WalletKeyLocator {
                branch: WalletBranch::Receive,
                index: index.try_into()?,
            }),
            InputStatus::Spendable,
        )?);
    }
    let boot = signer.bootstrap(BootstrapRequest {
        network,
        policy_asset: bytes.into(),
        deployment_salt: [0x11; 32].try_into()?,
        asset: AssetMetadata::new("Synthetic Rust report".into(), "RUST".into(), 0)?,
        issued_supply: 3_000_000_000_000_000u64.try_into()?,
        supply_mode: SupplyMode::IssuerManaged,
        policy_utxos: funding,
        fee: 4000.try_into()?,
        required_confirmations: 1,
    })?;
    let parent = |vout, ownership| {
        Utxo::new(
            damp_core::ledger::Outpoint::new(boot.txid.parse().unwrap(), vout),
            InputSource::Parent(
                elements::encode::deserialize(&hex::decode(&boot.transaction).unwrap()).unwrap(),
            ),
            ownership,
            InputStatus::Spendable,
        )
        .unwrap()
    };
    let transfer = signer.transfer(TransferRequest {
        deployment: boot.deployment.clone(),
        current_policy: boot.initial_policy.clone(),
        verifier_utxo: parent(0, Ownership::Unlocated),
        regulated_utxos: (1..=2)
            .map(|vout| {
                parent(
                    vout,
                    Ownership::Holder(HolderKeyLocator {
                        derivation_index: boot.holder_derivation_index,
                        owner_public_key: boot
                            .initial_holder_address
                            .owner_public_key
                            .parse()
                            .unwrap(),
                    }),
                )
            })
            .collect(),
        fee_utxos: vec![parent(
            4,
            Ownership::Wallet(WalletKeyLocator {
                branch: WalletBranch::Receive,
                index: KeyIndex::ZERO,
            }),
        )],
        recipient_address: boot.initial_holder_address.confidential_address.clone(),
        amount: 600.try_into()?,
        fee: 4000.try_into()?,
    })?;
    let credentials = export_audit_credentials_json(
        MNEMONIC,
        network,
        json!({"deployment":boot.deployment,"issuerTransactions":[boot.transaction]}),
    )?
    .to_string();
    let empty = Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: vec![],
        output: vec![TxOut {
            script_pubkey: Script::from(vec![0x51]),
            ..Default::default()
        }],
    };
    Ok(Fixture {
        request: json!({"deployment":boot.deployment,"policies":[boot.initial_policy],"confirmations":2,"dlpUpperBound":0}),
        credentials,
        transactions: vec![
            boot.transaction,
            transfer.transaction,
            elements::encode::serialize_hex(&empty),
        ],
        ids: vec![boot.txid, transfer.txid, empty.txid().to_string()],
    })
}
pub fn private(path: &Path, bytes: &[u8]) {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    f.write_all(bytes).unwrap();
}
pub fn hash(h: usize) -> String {
    format!("{:064x}", h + 1)
}
pub struct RpcState {
    pub fixture: Fixture,
    pub fail: AtomicBool,
    pub catching_up: AtomicBool,
    pub delay_ms: std::sync::atomic::AtomicU64,
    pub calls: Mutex<Vec<String>>,
    pub replace: AtomicBool,
}
pub struct Rpc {
    pub port: u16,
    pub state: Arc<RpcState>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Rpc {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
impl Rpc {
    pub fn start(f: Fixture) -> Self {
        let state = Arc::new(RpcState {
            fixture: f,
            fail: AtomicBool::new(false),
            catching_up: AtomicBool::new(false),
            delay_ms: std::sync::atomic::AtomicU64::new(0),
            calls: Mutex::new(vec![]),
            replace: AtomicBool::new(false),
        });
        let (send, recv) = std::sync::mpsc::channel();
        let (stop, shutdown) = tokio::sync::oneshot::channel();
        let s = state.clone();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(async move {
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    send.send(listener.local_addr().unwrap().port()).unwrap();
                    let app = axum::Router::new()
                        .route("/", axum::routing::post(rpc))
                        .with_state(s);
                    axum::serve(listener, app)
                        .with_graceful_shutdown(async {
                            let _ = shutdown.await;
                        })
                        .await
                        .unwrap();
                })
        });
        Self {
            port: recv.recv().unwrap(),
            state,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}
async fn rpc(
    axum::extract::State(s): axum::extract::State<Arc<RpcState>>,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> axum::Json<Value> {
    assert_eq!(
        headers.get("authorization").unwrap(),
        "Basic Zml4dHVyZTpjb29raWU="
    );
    tokio::time::sleep(Duration::from_millis(s.delay_ms.load(Ordering::Relaxed))).await;
    if s.fail.load(Ordering::Relaxed) {
        return axum::Json(json!({"error":{"message":"SECRET must never leak"},"result":null}));
    }
    let method = body["method"].as_str().unwrap();
    let p = &body["params"];
    s.calls.lock().unwrap().push(method.into());
    let f = &s.fixture;
    let bh = |h: usize| {
        if s.replace.load(Ordering::Relaxed) && h > 0 {
            format!("{:064x}", h + 100)
        } else {
            hash(h)
        }
    };
    let result = match method {
        "getblockcount" => json!(2),
        "getblockhash" => json!(bh(p[0].as_u64().unwrap() as usize)),
        "getblockchaininfo" => {
            json!({"chain":"liquidregtest","pruned":false,"initialblockdownload":s.catching_up.load(Ordering::Relaxed),"blocks":2,"headers":2})
        }
        "getindexinfo" => json!({"txindex":{"synced":true,"best_block_height":2}}),
        "getblockheader" => {
            let h = (0..3).find(|h| bh(*h) == p[0]).unwrap();
            if h == 0 {
                json!({"height":h})
            } else {
                json!({"height":h,"previousblockhash":bh(h-1)})
            }
        }
        "getblock" => {
            let h = (0..3).find(|h| bh(*h) == p[0]).unwrap();
            json!({"tx":[f.ids[h]]})
        }
        "getrawtransaction" => {
            let h = f
                .ids
                .iter()
                .position(|id| id == p[0].as_str().unwrap())
                .unwrap();
            if p[1] == true {
                json!({"confirmations":3-h,"blockhash":bh(h)})
            } else {
                json!(f.transactions[h])
            }
        }
        "gettxout" => json!({"confirmations":1}),
        _ => panic!("unexpected RPC method {method}"),
    };
    axum::Json(json!({"id":1,"error":null,"result":result}))
}
