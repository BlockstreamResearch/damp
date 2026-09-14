use crate::{
    BlockHash, Cancellation, Error, HistoryIndex, Result, Snapshot, TransactionRecord, Txid,
};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::{
    collections::HashSet,
    ops::ControlFlow,
    time::{Duration, Instant},
};

/// The caller supplies one provider and bounds each transport operation.
/// Returned transactions are decoded locally and their computed IDs are checked.
pub trait Provider {
    fn tip(&mut self) -> Result<u32>;
    fn block_hash(&mut self, height: u32) -> Result<BlockHash>;
    fn previous_block(&mut self, hash: BlockHash) -> Result<Option<BlockHash>>;
    fn txids(&mut self, hash: BlockHash) -> Result<Vec<Txid>>;
    fn transaction(&mut self, txid: Txid, block: BlockHash) -> Result<TransactionRecord>;
}

#[derive(Clone, Copy, Debug)]
pub struct Budget {
    pub(crate) transactions: usize,
    pub(crate) elapsed: Duration,
}
impl Budget {
    pub fn new(transactions: usize, elapsed: Duration) -> Result<Self> {
        if transactions == 0
            || transactions > 10_000
            || elapsed.is_zero()
            || elapsed > Duration::from_secs(30)
        {
            return Err(Error::Protocol);
        }
        Ok(Self {
            transactions,
            elapsed,
        })
    }
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            transactions: 100,
            elapsed: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum Progress {
    #[serde(rename = "index-reorg-check")]
    ReorgCheck {
        #[serde(rename = "checkedBlocks")]
        checked_blocks: usize,
    },
    #[serde(rename = "index-rolled-back")]
    RolledBack {
        #[serde(rename = "throughHeight")]
        through_height: i64,
    },
    #[serde(rename = "index-rolling-back")]
    RollingBack {
        #[serde(rename = "removedTransactions")]
        removed_transactions: usize,
        #[serde(rename = "removedBlocks")]
        removed_blocks: usize,
    },
    #[serde(rename = "index-catching-up")]
    CatchingUp {
        height: u32,
        #[serde(rename = "throughHeight")]
        through_height: u32,
        #[serde(rename = "blockTransactions")]
        block_transactions: usize,
        #[serde(rename = "indexedBlockTransactions")]
        indexed_block_transactions: usize,
    },
    #[serde(rename = "index-ready")]
    Ready {
        #[serde(rename = "throughHeight")]
        through_height: u32,
    },
}

pub(crate) fn emit(
    progress: &mut impl FnMut(Progress) -> Result<ControlFlow<()>>,
    value: Progress,
) -> Result<()> {
    match progress(value)? {
        ControlFlow::Continue(()) => Ok(()),
        ControlFlow::Break(()) => Err(Error::Cancelled),
    }
}

impl HistoryIndex {
    pub fn assert_snapshot(&self, chain: &mut impl Provider, snapshot: &Snapshot) -> Result<()> {
        if chain.tip()? < snapshot.tip() || chain.block_hash(snapshot.tip())? != snapshot.tip_hash()
        {
            return Err(Error::Snapshot("pinned tip changed"));
        }
        if chain.block_hash(snapshot.through())? != snapshot.through_hash()
            || chain.block_hash(snapshot.start())? != snapshot.start_hash()
        {
            return Err(Error::Snapshot("pinned confirmed range changed"));
        }
        Ok(())
    }

    /// Progress is a backpressure boundary. Returning Break cancels after the last commit.
    pub fn scan(
        &mut self,
        chain: &mut impl Provider,
        snapshot: &Snapshot,
        budget: Budget,
        progress: impl FnMut(Progress) -> Result<ControlFlow<()>>,
    ) -> Result<()> {
        self.scan_cancellable(chain, snapshot, budget, &Cancellation::default(), progress)
    }

    pub fn scan_cancellable(
        &mut self,
        chain: &mut impl Provider,
        snapshot: &Snapshot,
        budget: Budget,
        cancel: &Cancellation,
        mut progress: impl FnMut(Progress) -> Result<ControlFlow<()>>,
    ) -> Result<()> {
        cancel.check()?;
        let mut checked = crate::cancellation::CheckedProvider { chain, cancel };
        let chain = &mut checked;
        self.reconcile(chain, budget, cancel, &mut progress)?;
        self.assert_snapshot(chain, snapshot)?;
        let first: Option<u32> = self
            .db
            .query_row("SELECT MIN(height) FROM blocks", [], |r| r.get(0))?;
        if first.is_some_and(|h| h != snapshot.start()) {
            return Err(Error::Integrity("indexed bootstrap height differs"));
        }
        let completed: Option<u32> =
            self.db
                .query_row("SELECT MAX(height) FROM blocks WHERE complete=1", [], |r| {
                    r.get(0)
                })?;
        let mut height = completed.map_or(u64::from(snapshot.start()), |h| u64::from(h) + 1);
        let mut processed = 0;
        let mut started = Instant::now();
        while height <= u64::from(snapshot.through()) {
            let h = height as u32;
            self.space(0)?;
            let hash = chain.block_hash(h)?;
            let previous = chain.previous_block(hash)?;
            if h > snapshot.start() {
                let expected: Option<String> = self
                    .db
                    .query_row(
                        "SELECT hash FROM blocks WHERE height=? AND complete=1",
                        [h - 1],
                        |r| r.get(0),
                    )
                    .optional()?;
                if expected.is_none() || previous.map(|p| p.to_string()) != expected {
                    return Err(Error::Snapshot("provider chain is discontinuous"));
                }
            }
            let ids = chain.txids(hash)?;
            if ids.is_empty() || ids.len() > 500_000 {
                return Err(Error::Integrity(
                    "block transaction list unavailable or oversized",
                ));
            }
            if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
                return Err(Error::Integrity("duplicate transaction IDs"));
            }
            let block: Option<(String, usize, usize)> = self
                .db
                .query_row(
                    "SELECT hash,expected,next_tx FROM blocks WHERE height=?",
                    [h],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let mut position = if let Some((old, expected, cursor)) = block {
                if old != hash.to_string() || expected != ids.len() {
                    return Err(Error::Snapshot("partial block changed"));
                }
                cursor
            } else {
                cancel.check()?;
                self.db.execute(
                    "INSERT INTO blocks(height,hash,previous,expected) VALUES (?,?,?,?)",
                    params![
                        h,
                        hash.to_string(),
                        previous.map(|p| p.to_string()),
                        ids.len()
                    ],
                )?;
                0
            };
            let mut prefix = self.db.prepare(
                "SELECT position,txid FROM transactions WHERE height=? ORDER BY position",
            )?;
            let mut rows = prefix.query([h])?;
            let mut count = 0;
            while let Some(row) = rows.next()? {
                cancel.check()?;
                let stored_position: usize = row.get(0)?;
                let id: String = row.get(1)?;
                if count >= position
                    || stored_position != count
                    || ids.get(count).map(ToString::to_string).as_deref() != Some(&id)
                {
                    return Err(Error::Integrity(
                        "provider changed transaction prefix or stored positions",
                    ));
                }
                count += 1;
            }
            if count != position {
                return Err(Error::Integrity(
                    "partial cursor disagrees with transaction count",
                ));
            }
            drop(rows);
            drop(prefix);
            while position < ids.len() {
                let id = ids[position];
                let record = chain.transaction(id, hash)?;
                if record.txid() != id {
                    return Err(Error::Integrity("provider transaction ID mismatch"));
                }
                cancel.check()?;
                self.commit_transaction(h, position, hash, record)?;
                position += 1;
                processed += 1;
                if processed >= budget.transactions || started.elapsed() >= budget.elapsed {
                    emit(
                        &mut progress,
                        Progress::CatchingUp {
                            height: h,
                            through_height: snapshot.through(),
                            block_transactions: ids.len(),
                            indexed_block_transactions: position,
                        },
                    )?;
                    self.assert_snapshot(chain, snapshot)?;
                    processed = 0;
                    started = Instant::now();
                }
            }
            if chain.block_hash(h)? != hash {
                return Err(Error::Snapshot("block changed while indexing"));
            }
            cancel.check()?;
            self.db
                .execute("UPDATE blocks SET complete=1 WHERE height=?", [h])?;
            height += 1;
        }
        self.assert_snapshot(chain, snapshot)?;
        emit(
            &mut progress,
            Progress::Ready {
                through_height: snapshot.through(),
            },
        )
    }
}
