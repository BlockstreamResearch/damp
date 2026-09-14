use crate::{Error, Result, Scope, Snapshot, private};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

/// One process owns a database. Dropping it releases the lock after SQLite closes.
pub struct HistoryIndex {
    pub(crate) db: Connection,
    pub(crate) directory: PathBuf,
    pub(crate) max_bytes: u64,
    _lock: File,
}

impl HistoryIndex {
    pub fn open(directory: &Path, scope: &Scope, max_bytes: u64) -> Result<Self> {
        private::directory(directory)?;
        let lock = private::file(&directory.join("history.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| Error::Locked)?;
        let path = directory.join("history.sqlite3");
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let p = directory.join(format!("history.sqlite3{suffix}"));
            if p.try_exists()? || p.is_symlink() {
                private::check(&p, false)?;
            }
        }
        let _file = private::file(&path)?;
        let mut db = Connection::open(&path)?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192;",
        )?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let tables: u32 = db.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |r| r.get(0),
        )?;
        // Schema 2 cannot be confused with the former Python database.
        if (version != 2 && (version != 0 || tables != 0)) || (version == 2 && tables == 0) {
            return Err(Error::Schema);
        }
        let encoded = serde_json::to_string(scope)?;
        if tables > 0 {
            let old: Option<String> = db
                .query_row("SELECT value FROM metadata WHERE key='scope'", [], |r| {
                    r.get(0)
                })
                .optional()?;
            if old.as_deref() != Some(&encoded) {
                return Err(Error::Scope);
            }
        }
        let pages: u64 = db.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        if max_bytes < pages * 16 {
            return Err(Error::Allowance);
        }
        db.pragma_update(None, "max_page_count", max_bytes / pages)?;
        let tx = db.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS blocks (
                height INTEGER PRIMARY KEY,hash TEXT NOT NULL UNIQUE,previous TEXT,
                expected INTEGER NOT NULL CHECK(expected>0),next_tx INTEGER NOT NULL DEFAULT 0,
                complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
                CHECK(next_tx>=0 AND next_tx<=expected));
            CREATE TABLE IF NOT EXISTS transactions (
                txid TEXT PRIMARY KEY,height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
                position INTEGER NOT NULL,raw TEXT NOT NULL,decoded TEXT NOT NULL,UNIQUE(height,position));
            CREATE TABLE IF NOT EXISTS spends (
                outpoint TEXT PRIMARY KEY,txid TEXT NOT NULL REFERENCES transactions(txid) ON DELETE CASCADE,
                input_index INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS transaction_height ON transactions(height,position);
            CREATE INDEX IF NOT EXISTS spend_transaction ON spends(txid);
            PRAGMA user_version=2;")?;
        tx.execute(
            "INSERT OR REPLACE INTO metadata VALUES ('scope',?)",
            [&encoded],
        )?;
        tx.commit()?;
        Ok(Self {
            db,
            directory: directory.to_path_buf(),
            max_bytes,
            _lock: lock,
        })
    }

    pub fn pending(&self, request_id: &str) -> Result<Option<Snapshot>> {
        let entry: Option<String> = self
            .db
            .query_row("SELECT value FROM metadata WHERE key='pending'", [], |r| {
                r.get(0)
            })
            .optional()?;
        let Some(entry) = entry else { return Ok(None) };
        let (id, snapshot): (String, Snapshot) = serde_json::from_str(&entry)?;
        Ok((id == request_id).then_some(snapshot))
    }

    pub fn pin(&mut self, request_id: &str, snapshot: &Snapshot) -> Result<()> {
        if request_id.len() != 64 || !request_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Protocol);
        }
        self.db.execute(
            "INSERT OR REPLACE INTO metadata VALUES ('pending',?)",
            [serde_json::to_string(&(request_id, snapshot))?],
        )?;
        Ok(())
    }

    pub fn finish(&mut self) -> Result<()> {
        self.db
            .execute("DELETE FROM metadata WHERE key='pending'", [])?;
        Ok(())
    }

    pub(crate) fn space(&self, extra: u64) -> Result<()> {
        let allocated: u64 = self.db.query_row(
            "SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size()",
            [],
            |r| r.get(0),
        )?;
        // SQLite enforces max_page_count while allocating, including reuse within pages.
        // A payload estimate cannot distinguish reusable space inside existing B-trees.
        if allocated > self.max_bytes {
            return Err(Error::Allowance);
        }
        if fs2::available_space(&self.directory)? < (64 * 1024 * 1024).max(extra.saturating_mul(2))
        {
            return Err(Error::FreeSpace);
        }
        Ok(())
    }

    pub(crate) fn commit_transaction(
        &mut self,
        height: u32,
        position: usize,
        block_hash: crate::BlockHash,
        record: crate::TransactionRecord,
    ) -> Result<()> {
        let raw = record.to_string();
        let indexed = crate::IndexedTransaction {
            height,
            block_hash,
            transaction: record.inspect_public(),
        };
        let public = &indexed.transaction;
        let decoded = crate::encoding::public_json(&indexed)?;
        self.space(4 * (raw.len() + decoded.len()) as u64)?;
        let tx = self.db.transaction()?;
        let insert = || -> rusqlite::Result<()> {
            tx.execute(
                "INSERT INTO transactions VALUES (?,?,?,?,?)",
                params![public.txid.to_string(), height, position, raw, decoded],
            )?;
            for (number, input) in public.inputs.iter().enumerate() {
                if input.outpoint.txid() != [0; 32].into() {
                    tx.execute(
                        "INSERT INTO spends VALUES (?,?,?)",
                        params![input.outpoint.to_string(), public.txid.to_string(), number],
                    )?;
                }
            }
            tx.execute(
                "UPDATE blocks SET next_tx=? WHERE height=?",
                params![position + 1, height],
            )?;
            Ok(())
        };
        if let Err(e) = insert() {
            return Err(match e.sqlite_error_code() {
                Some(rusqlite::ErrorCode::ConstraintViolation) => {
                    Error::Integrity("duplicate transactions or conflicting spends")
                }
                Some(rusqlite::ErrorCode::DiskFull) => Error::Allowance,
                _ => e.into(),
            });
        }
        tx.commit()?;
        Ok(())
    }
}
