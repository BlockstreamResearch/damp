use crate::{Budget, Cancellation, Error, HistoryIndex, Progress, Provider, Result, scan::emit};
use rusqlite::OptionalExtension;
use std::{ops::ControlFlow, time::Instant};

impl HistoryIndex {
    pub(crate) fn reconcile(
        &mut self,
        chain: &mut impl Provider,
        budget: Budget,
        cancel: &Cancellation,
        progress: &mut impl FnMut(Progress) -> Result<ControlFlow<()>>,
    ) -> Result<()> {
        let interrupted: Option<String> = self
            .db
            .query_row("SELECT value FROM metadata WHERE key='rollback'", [], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(height) = interrupted {
            self.rollback_batches(
                height
                    .parse()
                    .map_err(|_| Error::Integrity("invalid rollback cursor"))?,
                budget,
                cancel,
                progress,
            )?;
        }
        let latest: Option<u32> = self
            .db
            .query_row("SELECT MAX(height) FROM blocks", [], |r| r.get(0))?;
        let Some(latest) = latest else { return Ok(()) };
        let ceiling = chain.tip()?;
        let mut height = i64::from(latest);
        let mut checked = 0;
        let mut started = Instant::now();
        let ancestor = loop {
            cancel.check()?;
            let row: Option<(u32, String)> = self
                .db
                .query_row(
                    "SELECT height,hash FROM blocks WHERE height<=? ORDER BY height DESC LIMIT 1",
                    [height],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((h, hash)) = row else { break -1 };
            if h <= ceiling && chain.block_hash(h)?.to_string() == hash {
                break i64::from(h);
            }
            height = i64::from(h) - 1;
            checked += 1;
            if checked % 64 == 0 || started.elapsed() >= budget.elapsed {
                emit(
                    progress,
                    Progress::ReorgCheck {
                        checked_blocks: checked,
                    },
                )?;
                started = Instant::now();
            }
        };
        if ancestor != i64::from(latest) {
            self.rollback_batches(ancestor, budget, cancel, progress)?;
        }
        Ok(())
    }

    fn rollback_batches(
        &mut self,
        height: i64,
        budget: Budget,
        cancel: &Cancellation,
        progress: &mut impl FnMut(Progress) -> Result<ControlFlow<()>>,
    ) -> Result<()> {
        cancel.check()?;
        // Views use this constant-size boundary while deletion is suspended.
        self.db.execute(
            "INSERT OR REPLACE INTO metadata VALUES ('rollback',?)",
            [height.to_string()],
        )?;
        let mut removed_transactions = 0;
        let mut removed_blocks = 0;
        let mut operations = 0;
        let mut started = Instant::now();
        loop {
            cancel.check()?;
            self.space(0)?;
            let block: Option<u32> = self
                .db
                .query_row(
                    "SELECT height FROM blocks WHERE height>? ORDER BY height DESC LIMIT 1",
                    [height],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(block) = block else { break };
            let transaction: Option<String> = self
                .db
                .query_row(
                    "SELECT txid FROM transactions WHERE height=? ORDER BY position DESC LIMIT 1",
                    [block],
                    |r| r.get(0),
                )
                .optional()?;
            cancel.check()?;
            if let Some(transaction) = transaction {
                self.db
                    .execute("DELETE FROM transactions WHERE txid=?", [transaction])?;
                removed_transactions += 1;
            } else {
                self.db
                    .execute("DELETE FROM blocks WHERE height=?", [block])?;
                removed_blocks += 1;
            }
            operations += 1;
            if operations >= budget.transactions || started.elapsed() >= budget.elapsed {
                emit(
                    progress,
                    Progress::RollingBack {
                        removed_transactions,
                        removed_blocks,
                    },
                )?;
                operations = 0;
                started = Instant::now();
            }
        }
        cancel.check()?;
        self.db
            .execute("DELETE FROM metadata WHERE key='rollback'", [])?;
        emit(
            progress,
            Progress::RolledBack {
                through_height: height,
            },
        )
    }
}
