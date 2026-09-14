#![allow(dead_code)]
use damp_indexer::{BlockHash, Error, Provider, Result, Scope, Snapshot, TransactionRecord, Txid};
use elements::{LockTime, OutPoint, Script, Transaction, TxIn, TxOut, hashes::Hash as _};
use std::collections::HashMap;

pub fn record(number: u32, previous: Option<&TransactionRecord>) -> TransactionRecord {
    TransactionRecord::new(Transaction {
        version: 2,
        lock_time: LockTime::from_consensus(number),
        input: vec![TxIn {
            previous_output: previous.map_or(OutPoint::null(), |p| {
                OutPoint::new(p.transaction().txid(), 0)
            }),
            ..TxIn::default()
        }],
        output: vec![TxOut {
            script_pubkey: Script::from(vec![0x51]),
            ..TxOut::default()
        }],
    })
    .unwrap()
}

pub struct Chain {
    pub hashes: Vec<BlockHash>,
    pub blocks: Vec<Vec<Txid>>,
    pub records: HashMap<Txid, TransactionRecord>,
    pub reads: usize,
    pub fail: Option<Txid>,
    pub wrong: bool,
    pub discontinuous: bool,
    pub reorg_on_read: bool,
    pub cancel_on_read: Option<damp_indexer::Cancellation>,
}
impl Chain {
    pub fn new(blocks: u32, per_block: u32) -> Self {
        let mut result = Self {
            hashes: Vec::new(),
            blocks: Vec::new(),
            records: HashMap::new(),
            reads: 0,
            fail: None,
            wrong: false,
            discontinuous: false,
            reorg_on_read: false,
            cancel_on_read: None,
        };
        let mut previous = None;
        for h in 0..blocks {
            result
                .hashes
                .push(format!("{:064x}", h + 100000).parse().unwrap());
            let mut ids = Vec::new();
            for p in 0..per_block {
                let tx = record(h * per_block + p + 1, previous.as_ref());
                ids.push(tx.txid());
                previous = Some(tx.clone());
                result.records.insert(tx.txid(), tx);
            }
            result.blocks.push(ids);
        }
        result
    }
    pub fn snapshot(&self) -> Snapshot {
        let h = self.hashes.len() as u32 - 1;
        Snapshot::new(
            (0, self.hashes[0]),
            (h, self.hashes[h as usize]),
            (h, self.hashes[h as usize]),
        )
        .unwrap()
    }
    pub fn reorg(&mut self, from: usize) {
        for h in from..self.hashes.len() {
            self.hashes[h] = format!("{:064x}", h + 200000).parse().unwrap();
        }
    }
}
impl Provider for Chain {
    fn tip(&mut self) -> Result<u32> {
        Ok(self.hashes.len() as u32 - 1)
    }
    fn block_hash(&mut self, h: u32) -> Result<BlockHash> {
        self.hashes.get(h as usize).copied().ok_or(Error::Provider)
    }
    fn previous_block(&mut self, hash: BlockHash) -> Result<Option<BlockHash>> {
        if self.discontinuous {
            return Ok(Some(BlockHash::all_zeros()));
        }
        let h = self
            .hashes
            .iter()
            .position(|v| *v == hash)
            .ok_or(Error::Provider)?;
        Ok(h.checked_sub(1).map(|h| self.hashes[h]))
    }
    fn txids(&mut self, hash: BlockHash) -> Result<Vec<Txid>> {
        let h = self
            .hashes
            .iter()
            .position(|v| *v == hash)
            .ok_or(Error::Provider)?;
        Ok(self.blocks[h].clone())
    }
    fn transaction(&mut self, id: Txid, _: BlockHash) -> Result<TransactionRecord> {
        if self.fail == Some(id) {
            return Err(Error::Provider);
        }
        self.reads += 1;
        if self.reorg_on_read {
            self.reorg(0);
            self.reorg_on_read = false;
        }
        if let Some(cancel) = &self.cancel_on_read {
            cancel.cancel();
        }
        if self.wrong {
            return Ok(record(999_999, None));
        }
        self.records.get(&id).cloned().ok_or(Error::Provider)
    }
}
pub fn scope() -> Scope {
    serde_json::from_value(
        serde_json::json!({"deploymentId":"fixture","network":"elements-regtest",
        "genesis":"00".repeat(32),"provider":"fixture://chain","decoder":"native-test"}),
    )
    .unwrap()
}
