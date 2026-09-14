use crate::IndexedTransaction;
use crate::{HistoryIndex, Outpoint, Result, Txid};
use rusqlite::{OptionalExtension, params};

/// Queries exclude unfinished blocks and facts after the requested boundary.
pub struct SnapshotView<'a> {
    index: &'a HistoryIndex,
    through: u32,
}

impl HistoryIndex {
    pub fn view(&self, through: u32) -> SnapshotView<'_> {
        SnapshotView {
            index: self,
            through,
        }
    }
}

impl SnapshotView<'_> {
    /// Read one row after a public block position, for bounded IPC consumers.
    pub fn next(
        &self,
        after: Option<(u32, u32)>,
    ) -> Result<Option<((u32, u32), IndexedTransaction)>> {
        let (height, position) = after.map_or((-1i64, -1i64), |(h, p)| (h.into(), p.into()));
        let row: Option<(u32,u32,String)> = self.index.db.query_row("SELECT t.height,t.position,t.decoded FROM transactions t JOIN blocks b USING(height)
            WHERE b.complete=1 AND t.height<=COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='rollback'),4294967295) AND t.height<=? AND (t.height,t.position)>(?,?) ORDER BY t.height,t.position LIMIT 1",
            params![self.through,height,position], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        row.map(|(h, p, s)| Ok(((h, p), serde_json::from_str(&s)?)))
            .transpose()
    }
    /// Visit one transaction at a time, without collecting the entire history.
    pub fn transactions(
        &self,
        mut visit: impl FnMut(IndexedTransaction) -> Result<()>,
    ) -> Result<()> {
        let mut statement = self.index.db.prepare(
            "SELECT t.decoded FROM transactions t JOIN blocks b USING(height)
            WHERE b.complete=1 AND t.height<=COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='rollback'),4294967295) AND t.height<=? ORDER BY t.height,t.position",
        )?;
        let mut rows = statement.query([self.through])?;
        while let Some(row) = rows.next()? {
            let decoded: String = row.get(0)?;
            visit(serde_json::from_str(&decoded)?)?;
        }
        Ok(())
    }
    pub fn get(&self, txid: Txid) -> Result<Option<IndexedTransaction>> {
        let row: Option<String> = self
            .index
            .db
            .query_row(
                "SELECT t.decoded FROM transactions t JOIN blocks b USING(height)
            WHERE t.txid=? AND b.complete=1 AND t.height<=COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='rollback'),4294967295) AND t.height<=?",
                params![txid.to_string(), self.through],
                |r| r.get(0),
            )
            .optional()?;
        row.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub fn raw(&self, txid: Txid) -> Result<Option<String>> {
        Ok(self
            .index
            .db
            .query_row(
                "SELECT t.raw FROM transactions t JOIN blocks b USING(height)
            WHERE t.txid=? AND b.complete=1 AND t.height<=COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='rollback'),4294967295) AND t.height<=?",
                params![txid.to_string(), self.through],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn spend(&self, outpoint: Outpoint) -> Result<Option<(Txid, u32)>> {
        let row: Option<(String, u32)> = self
            .index
            .db
            .query_row(
                "SELECT s.txid,s.input_index FROM spends s
            JOIN transactions t ON s.txid=t.txid JOIN blocks b USING(height)
            WHERE s.outpoint=? AND b.complete=1 AND t.height<=COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='rollback'),4294967295) AND t.height<=?",
                params![outpoint.to_string(), self.through],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(id, n)| {
            Ok((
                id.parse()
                    .map_err(|_| crate::Error::Integrity("stored transaction ID"))?,
                n,
            ))
        })
        .transpose()
    }
}
