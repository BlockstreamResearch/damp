mod support;
use damp_indexer::{Budget, Error, HistoryIndex, Snapshot};
use std::{
    fs,
    ops::ControlFlow,
    os::unix::fs::{PermissionsExt, symlink},
};
use support::{Chain, scope};

#[test]
fn lock_scope_schema_permissions_and_disk_allowance_are_enforced() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let index = HistoryIndex::open(&path, &scope(), 1024 * 1024).unwrap();
    assert!(matches!(
        HistoryIndex::open(&path, &scope(), 1024 * 1024),
        Err(Error::Locked)
    ));
    drop(index);
    let current = scope();
    let different = damp_indexer::Scope::new(
        current.deployment_id().into(),
        current.network(),
        current.genesis(),
        current.provider().into(),
        "changed".into(),
    )
    .unwrap();
    assert!(matches!(
        HistoryIndex::open(&path, &different, 1024 * 1024),
        Err(Error::Scope)
    ));
    assert!(matches!(
        HistoryIndex::open(&path, &scope(), 1),
        Err(Error::Allowance)
    ));
    let db = rusqlite::Connection::open(path.join("history.sqlite3")).unwrap();
    db.pragma_update(None, "user_version", 1).unwrap();
    drop(db);
    assert!(matches!(
        HistoryIndex::open(&path, &scope(), 1024 * 1024),
        Err(Error::Schema)
    ));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        HistoryIndex::open(&path, &scope(), 1024 * 1024),
        Err(Error::PrivatePath)
    ));
}

#[test]
fn symlinks_and_hardlinks_are_rejected_without_modifying_targets() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("original");
    fs::write(&target, b"preserve").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    let path = temp.path().join("index");
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&target, path.join("history.sqlite3")).unwrap();
    assert!(HistoryIndex::open(&path, &scope(), 1024 * 1024).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"preserve");
    fs::remove_file(path.join("history.sqlite3")).unwrap();
    fs::hard_link(&target, path.join("history.sqlite3")).unwrap();
    assert!(HistoryIndex::open(&path, &scope(), 1024 * 1024).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"preserve");
}

#[test]
fn malformed_snapshot_and_cursor_corruption_fail_closed() {
    let mut value = serde_json::to_value(Chain::new(2, 1).snapshot()).unwrap();
    value["startHeight"] = 5.into();
    assert!(serde_json::from_value::<Snapshot>(value).is_err());
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let mut chain = Chain::new(2, 4);
    let mut index = HistoryIndex::open(&path, &scope(), 1024 * 1024).unwrap();
    let snapshot = chain.snapshot();
    let _ = index.scan(
        &mut chain,
        &snapshot,
        Budget::new(2, std::time::Duration::from_secs(1)).unwrap(),
        |_| Ok(ControlFlow::Break(())),
    );
    drop(index);
    let db = rusqlite::Connection::open(path.join("history.sqlite3")).unwrap();
    db.execute("UPDATE blocks SET next_tx=3 WHERE height=0", [])
        .unwrap();
    drop(db);
    let mut index = HistoryIndex::open(&path, &scope(), 1024 * 1024).unwrap();
    assert!(matches!(
        index.scan(&mut chain, &snapshot, Budget::default(), |_| Ok(
            ControlFlow::Continue(())
        )),
        Err(Error::Integrity(_))
    ));
}

#[test]
fn allowance_exhaustion_preserves_cursor_and_reuses_freed_pages_after_reorg() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let mut chain = Chain::new(60, 10);
    let mut index = HistoryIndex::open(&path, &scope(), 128 * 1024).unwrap();
    let snapshot = chain.snapshot();
    assert!(matches!(
        index.scan(&mut chain, &snapshot, Budget::default(), |_| Ok(
            ControlFlow::Continue(())
        )),
        Err(Error::Allowance)
    ));
    drop(index);
    let db = rusqlite::Connection::open(path.join("history.sqlite3")).unwrap();
    let (rows, cursors): (u32, u32) = db
        .query_row(
            "SELECT (SELECT COUNT(*) FROM transactions),(SELECT SUM(next_tx) FROM blocks)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(rows > 0 && rows < 600);
    assert_eq!(rows, cursors);
    drop(db);
    let mut index = HistoryIndex::open(&path, &scope(), 4 * 1024 * 1024).unwrap();
    index
        .scan(&mut chain, &snapshot, Budget::default(), |_| {
            Ok(ControlFlow::Continue(()))
        })
        .unwrap();
    drop(index);
    let allowance = fs::metadata(path.join("history.sqlite3")).unwrap().len();
    let mut index = HistoryIndex::open(&path, &scope(), allowance).unwrap();
    chain.reorg(0);
    let snapshot = chain.snapshot();
    index
        .scan(&mut chain, &snapshot, Budget::default(), |_| {
            Ok(ControlFlow::Continue(()))
        })
        .unwrap();
    let mut rows = 0;
    index
        .view(59)
        .transactions(|_| {
            rows += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(rows, 600);
    assert!(fs::metadata(path.join("history.sqlite3")).unwrap().len() <= allowance);
}

#[test]
fn public_json_expansion_is_bounded_before_persistence() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let mut chain = Chain::new(1, 1);
    let mut tx = chain.records[&chain.blocks[0][0]].transaction().clone();
    tx.output = vec![elements::TxOut::default(); 140_000];
    let tx = damp_indexer::TransactionRecord::new(tx).unwrap();
    chain.blocks[0][0] = tx.txid();
    chain.records.insert(tx.txid(), tx);
    let mut index = HistoryIndex::open(&path, &scope(), 64 * 1024 * 1024).unwrap();
    let snapshot = chain.snapshot();
    assert!(matches!(
        index.scan(&mut chain, &snapshot, Budget::default(), |_| Ok(
            ControlFlow::Continue(())
        )),
        Err(Error::Integrity(
            "public transaction exceeds JSON allowance"
        ))
    ));
    assert!(index.view(0).get(chain.blocks[0][0]).unwrap().is_none());
    drop(index);
    let db = rusqlite::Connection::open(path.join("history.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT next_tx FROM blocks", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        0
    );
}

#[test]
fn scope_deserialization_rejects_authentication_in_provider_identity() {
    for provider in [
        "https://user:secret@example.invalid",
        "https://example.invalid/?token=secret",
        "",
    ] {
        let mut value = serde_json::to_value(scope()).unwrap();
        value["provider"] = provider.into();
        assert!(serde_json::from_value::<damp_indexer::Scope>(value).is_err());
    }
}
