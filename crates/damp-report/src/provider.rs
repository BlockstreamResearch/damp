use crate::config::{ProviderConfig, read_private};
use anyhow::{Context, ensure};
use damp_indexer::{BlockHash, Provider, TransactionRecord, Txid};
use damp_signer::network::DeploymentNetwork;
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::{io::Read, time::Duration};

const MAX_RESPONSE: u64 = 32 * 1024 * 1024;
pub struct Chain {
    client: Client,
    config: ProviderConfig,
    network: DeploymentNetwork,
}
impl Chain {
    pub fn new(config: ProviderConfig, network: DeploymentNetwork) -> anyhow::Result<Self> {
        ensure!(
            network == DeploymentNetwork::LiquidTestnet
                || matches!(config, ProviderConfig::Rpc { .. }),
            "Elements regtest requires local RPC"
        );
        if let ProviderConfig::Esplora { url } = &config {
            let u = reqwest::Url::parse(url).map_err(|_| anyhow::anyhow!("invalid Esplora URL"))?;
            ensure!(
                u.scheme() == "https"
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
                    && u.fragment().is_none(),
                "Esplora requires HTTPS without credentials, query or fragment"
            );
        }
        Ok(Self {
            config,
            network,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(45))
                .build()
                .context("cannot initialize provider transport")?,
        })
    }
    pub fn identity(&self) -> String {
        match &self.config {
            ProviderConfig::Rpc { port, .. } => format!("http://127.0.0.1:{port}"),
            ProviderConfig::Esplora { url } => url.trim_end_matches('/').to_owned(),
        }
    }
    pub fn label(&self) -> String {
        if self.is_rpc() {
            "local-elements-node".into()
        } else {
            self.identity()
        }
    }
    pub fn is_rpc(&self) -> bool {
        matches!(self.config, ProviderConfig::Rpc { .. })
    }
    fn bytes(&self, req: reqwest::blocking::RequestBuilder) -> anyhow::Result<Vec<u8>> {
        let response = req.send().map_err(|_| {
            anyhow::anyhow!(
                "provider unreachable or timed out; check provider address and node status"
            )
        })?;
        ensure!(
            response.status().is_success(),
            "provider HTTP request failed; check provider availability and RPC cookie"
        );
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| anyhow::anyhow!("provider response interrupted"))?;
        ensure!(
            bytes.len() as u64 <= MAX_RESPONSE,
            "provider response exceeds 32 MiB allowance"
        );
        Ok(bytes)
    }
    pub fn rpc(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let ProviderConfig::Rpc { cookie, .. } = &self.config else {
            anyhow::bail!("RPC unavailable")
        };
        let cookie = read_private(cookie, 4096).map_err(|_| {
            anyhow::anyhow!("cannot read RPC cookie; check private file path and permissions")
        })?;
        let (user, pass) = cookie
            .trim()
            .split_once(':')
            .context("invalid RPC cookie")?;
        let bytes = self.bytes(
            self.client
                .post(self.identity())
                .basic_auth(user, Some(pass))
                .json(&json!({"id":1,"method":method,"params":params})),
        )?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid provider JSON"))?;
        ensure!(
            value.get("error").is_some_and(Value::is_null) && value.get("result").is_some(),
            "node request failed; check archival history and synced txindex"
        );
        Ok(value["result"].clone())
    }
    fn get_text(&self, path: &str) -> anyhow::Result<String> {
        String::from_utf8(self.bytes(self.client.get(format!("{}{path}", self.identity())))?)
            .context("invalid provider text")
    }
    fn get(&self, path: &str) -> anyhow::Result<Value> {
        serde_json::from_str(&self.get_text(path)?)
            .map_err(|_| anyhow::anyhow!("invalid provider JSON"))
    }
    pub fn height(&self) -> anyhow::Result<u32> {
        if self.is_rpc() {
            height(&self.rpc("getblockcount", json!([]))?)
        } else {
            self.get_text("/blocks/tip/height")?
                .trim()
                .parse()
                .context("invalid provider height")
        }
    }
    pub fn hash(&self, h: u32) -> anyhow::Result<BlockHash> {
        let s = if self.is_rpc() {
            self.rpc("getblockhash", json!([h]))?
                .as_str()
                .context("invalid block hash")?
                .to_owned()
        } else {
            self.get_text(&format!("/block-height/{h}"))?
        };
        s.trim().parse().context("invalid provider block hash")
    }
    pub fn readiness(&self) -> anyhow::Result<Value> {
        let genesis = self.hash(0)?;
        if self.network == DeploymentNetwork::LiquidTestnet {
            ensure!(
                genesis.to_string()
                    == "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1",
                "provider genesis does not match Liquid testnet"
            );
        }
        if !self.is_rpc() {
            let tip = self.height()?;
            self.hash(tip)?;
            return Ok(json!({"ready":true,"provider":"public-esplora","blocks":tip}));
        }
        let info = self.rpc("getblockchaininfo", json!([]))?;
        ensure!(
            info["chain"]
                == if self.network == DeploymentNetwork::ElementsRegtest {
                    "liquidregtest"
                } else {
                    "liquidtestnet"
                },
            "node network mismatch"
        );
        ensure!(
            info["pruned"] == false,
            "archival history required; configured node is pruned"
        );
        let indexes = self.rpc("getindexinfo", json!([]))?;
        let index = &indexes["txindex"];
        let blocks = height(&info["blocks"])?;
        let headers = height(&info["headers"])?;
        let ready = info["initialblockdownload"] == false
            && blocks >= headers
            && index["synced"] == true
            && index["best_block_height"]
                .as_u64()
                .is_some_and(|n| n >= blocks as u64);
        Ok(
            json!({"ready":ready,"phase":"node-catching-up","blocks":blocks,"headers":headers,"transactionIndexEnabled":index.is_object(),"transactionIndexSynced":index["synced"] == true}),
        )
    }
    pub fn status(&self, txid: Txid) -> anyhow::Result<(u32, BlockHash)> {
        let v = if self.is_rpc() {
            let tx = self.rpc("getrawtransaction", json!([txid.to_string(), true]))?;
            ensure!(
                tx["confirmations"].as_u64().unwrap_or(0) > 0,
                "bootstrap is not confirmed"
            );
            let block: BlockHash = tx["blockhash"]
                .as_str()
                .context("bootstrap block missing")?
                .parse()?;
            let header = self.rpc("getblockheader", json!([block.to_string()]))?;
            return Ok((height(&header["height"])?, block));
        } else {
            self.get(&format!("/tx/{txid}/status"))?
        };
        ensure!(v["confirmed"] == true, "bootstrap is not confirmed");
        Ok((
            height(&v["block_height"])?,
            v["block_hash"]
                .as_str()
                .context("bootstrap block missing")?
                .parse()?,
        ))
    }
    pub fn raw(&self, id: Txid, block: Option<BlockHash>) -> anyhow::Result<TransactionRecord> {
        let raw = if self.is_rpc() {
            let params = if let Some(b) = block {
                json!([id.to_string(), false, b.to_string()])
            } else {
                json!([id.to_string(), false])
            };
            self.rpc("getrawtransaction", params)?
                .as_str()
                .context("missing transaction")?
                .to_owned()
        } else {
            self.get_text(&format!("/tx/{id}/hex"))?
        };
        ensure!(raw.len() <= 8_000_000, "transaction exceeds byte allowance");
        let record: TransactionRecord = raw
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid provider transaction"))?;
        ensure!(record.txid() == id, "provider transaction ID mismatch");
        Ok(record)
    }
    pub fn crosscheck(
        &self,
        outpoint: damp_indexer::Outpoint,
        through: u32,
        tip: u32,
    ) -> anyhow::Result<bool> {
        if self.is_rpc() {
            // gettxout cannot distinguish a historical unspent output from a later spend.
            if through < tip {
                return Ok(true);
            }
            return Ok(!self
                .rpc(
                    "gettxout",
                    json!([outpoint.txid().to_string(), outpoint.vout(), false]),
                )?
                .is_null());
        }
        let v = self.get(&format!(
            "/tx/{}/outspend/{}",
            outpoint.txid(),
            outpoint.vout()
        ))?;
        ensure!(v["spent"].is_boolean(), "invalid outspend response");
        if v["spent"] == false {
            return Ok(true);
        }
        ensure!(
            v["status"]["confirmed"].is_boolean(),
            "invalid outspend status"
        );
        Ok(v["status"]["confirmed"] == false || height(&v["status"]["block_height"])? > through)
    }
}
fn height(v: &Value) -> anyhow::Result<u32> {
    v.as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .context("invalid provider height")
}
impl Provider for Chain {
    fn tip(&mut self) -> damp_indexer::Result<u32> {
        self.height().map_err(|_| damp_indexer::Error::Provider)
    }
    fn block_hash(&mut self, h: u32) -> damp_indexer::Result<BlockHash> {
        self.hash(h).map_err(|_| damp_indexer::Error::Provider)
    }
    fn previous_block(&mut self, h: BlockHash) -> damp_indexer::Result<Option<BlockHash>> {
        let v = if self.is_rpc() {
            self.rpc("getblockheader", json!([h.to_string()]))
        } else {
            self.get(&format!("/block/{h}"))
        }
        .map_err(|_| damp_indexer::Error::Provider)?;
        v.get("previousblockhash")
            .filter(|s| !s.is_null())
            .map(|s| {
                s.as_str()
                    .ok_or(damp_indexer::Error::Provider)?
                    .parse()
                    .map_err(|_| damp_indexer::Error::Provider)
            })
            .transpose()
    }
    fn txids(&mut self, h: BlockHash) -> damp_indexer::Result<Vec<Txid>> {
        let v = if self.is_rpc() {
            self.rpc("getblock", json!([h.to_string(), 1]))
                .map(|v| v["tx"].clone())
        } else {
            self.get(&format!("/block/{h}/txids"))
        }
        .map_err(|_| damp_indexer::Error::Provider)?;
        serde_json::from_value(v).map_err(|_| damp_indexer::Error::Provider)
    }
    fn transaction(&mut self, id: Txid, h: BlockHash) -> damp_indexer::Result<TransactionRecord> {
        self.raw(id, Some(h))
            .map_err(|_| damp_indexer::Error::Provider)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
    };
    #[test]
    fn esplora_transport_checks_snapshot_data_outspends_and_redacts_failures() -> anyhow::Result<()>
    {
        let tx = damp_signer::transaction::TransactionRecord::new(elements::Transaction {
            version: 2,
            lock_time: elements::LockTime::ZERO,
            input: vec![],
            output: vec![elements::TxOut {
                script_pubkey: elements::Script::from(vec![0x51]),
                ..Default::default()
            }],
        })?;
        let id = tx.txid();
        let block = format!("{:064x}", 2);
        let previous = format!("{:064x}", 1);
        let mut expected = vec![
            (
                "/block-height/0".into(),
                200,
                "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1".into(),
            ),
            ("/blocks/tip/height".into(), 200, "2".into()),
            ("/block-height/2".into(), 200, block.clone()),
            (
                format!("/tx/{id}/status"),
                200,
                json!({"confirmed":true,"block_height":1,"block_hash":block}).to_string(),
            ),
            (
                format!("/block/{block}/txids"),
                200,
                json!([id]).to_string(),
            ),
            (
                format!("/block/{block}"),
                200,
                json!({"previousblockhash":previous}).to_string(),
            ),
            (format!("/tx/{id}/hex"), 200, tx.to_string()),
        ];
        for body in [
            json!({"spent":false}),
            json!({"spent":true,"status":{"confirmed":false}}),
            json!({"spent":true,"status":{"confirmed":true,"block_height":3}}),
            json!({"spent":true,"status":{"confirmed":true,"block_height":1}}),
        ] {
            expected.push((format!("/tx/{id}/outspend/0"), 200, body.to_string()));
        }
        expected.push((
            "/blocks/tip/height".into(),
            500,
            "SECRET provider diagnostic".into(),
        ));
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let server = std::thread::spawn(move || {
            for (path, status, body) in expected {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert_eq!(first.split_whitespace().nth(1), Some(path.as_str()));
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    assert!(!line.to_ascii_lowercase().starts_with("authorization:"));
                    if line == "\r\n" {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        // Only this internal fixture bypasses Config's production HTTPS requirement.
        let mut chain = Chain {
            config: ProviderConfig::Esplora {
                url: format!("http://127.0.0.1:{port}"),
            },
            network: DeploymentNetwork::LiquidTestnet,
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
        };
        assert_eq!(chain.readiness()?["ready"], true);
        assert_eq!(chain.status(id)?, (1, block.parse()?));
        assert_eq!(chain.txids(block.parse()?)?, vec![id]);
        assert_eq!(
            chain.previous_block(block.parse()?)?,
            Some(previous.parse()?)
        );
        assert_eq!(chain.transaction(id, block.parse()?)?, tx);
        let output = damp_indexer::Outpoint::new(id, 0);
        assert!(chain.crosscheck(output, 1, 2)?);
        assert!(chain.crosscheck(output, 1, 2)?);
        assert!(chain.crosscheck(output, 1, 2)?);
        assert!(!chain.crosscheck(output, 1, 2)?);
        let error = chain.height().unwrap_err().to_string();
        assert!(!error.contains("SECRET"));
        assert!(error.contains("provider HTTP"));
        server.join().unwrap();
        Ok(())
    }
}
