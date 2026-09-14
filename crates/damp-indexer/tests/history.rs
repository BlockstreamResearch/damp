mod support;
use damp_indexer::{Budget, Error, HistoryIndex, Outpoint, Progress, Snapshot};
use std::{ops::ControlFlow, time::Duration};
use support::{Chain, scope};

fn run(index: &mut HistoryIndex, chain: &mut Chain) -> damp_indexer::Result<()> {
    let snapshot = chain.snapshot();
    index.scan(chain, &snapshot, Budget::default(), |_| {
        Ok(ControlFlow::Continue(()))
    })
}
fn count(index: &HistoryIndex, through: u32) -> usize {
    let mut n = 0;
    index
        .view(through)
        .transactions(|_| {
            n += 1;
            Ok(())
        })
        .unwrap();
    n
}
fn open(path: &std::path::Path) -> HistoryIndex {
    HistoryIndex::open(path, &scope(), 128 * 1024 * 1024).unwrap()
}

#[test]
fn complete_history_resumes_partial_block_without_refetching() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let mut chain = Chain::new(350, 32);
    let snapshot = chain.snapshot();
    let mut index = open(&path);
    index.pin(&"a".repeat(64), &snapshot).unwrap();
    assert!(matches!(
        index.scan(
            &mut chain,
            &snapshot,
            Budget::new(17, Duration::from_secs(5)).unwrap(),
            |_| Ok(ControlFlow::Break(()))
        ),
        Err(Error::Cancelled)
    ));
    assert_eq!(count(&index, 349), 0);
    drop(index);
    let mut index = open(&path);
    assert_eq!(index.pending(&"a".repeat(64)).unwrap(), Some(snapshot));
    run(&mut index, &mut chain).unwrap();
    assert_eq!(count(&index, 349), 11_200);
    assert_eq!(chain.reads, 11_200);
    run(&mut index, &mut chain).unwrap();
    assert_eq!(chain.reads, 11_200);
    index.finish().unwrap();
    assert!(index.pending(&"a".repeat(64)).unwrap().is_none());
    let old = chain.snapshot();
    chain.reorg(2);
    assert!(matches!(
        index.scan(&mut chain, &old, Budget::default(), |p| {
            Ok(if matches!(p, Progress::RollingBack { .. }) {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            })
        }),
        Err(Error::Cancelled)
    ));
    assert_eq!(count(&index, 349), 64);
    drop(index);
    // The provider can return to its old branch while deletion is suspended.
    chain.hashes = Chain::new(350, 0).hashes;
    let mut index = open(&path);
    run(&mut index, &mut chain).unwrap();
    assert_eq!(count(&index, 349), 11_200);
    assert_eq!(chain.reads, 11_200 + 11_136);
    assert_eq!(
        index
            .view(349)
            .spend(Outpoint::new(chain.blocks[349][30], 0))
            .unwrap(),
        Some((chain.blocks[349][31], 0))
    );
}

#[test]
fn same_height_deep_and_prebootstrap_reorgs_remove_orphans() {
    for depth in [1, 80, 100] {
        let temp = tempfile::tempdir().unwrap();
        let mut index = open(&temp.path().join("index"));
        let mut chain = Chain::new(100, 2);
        let old = chain.snapshot();
        run(&mut index, &mut chain).unwrap();
        chain.reorg(100 - depth);
        let error = index
            .scan(&mut chain, &old, Budget::default(), |_| {
                Ok(ControlFlow::Continue(()))
            })
            .unwrap_err();
        assert!(matches!(error, Error::Snapshot(_)));
        assert_eq!(count(&index, 99), (100 - depth) * 2);
        run(&mut index, &mut chain).unwrap();
        assert_eq!(count(&index, 99), 200);
    }
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(30, 2);
    let old = Snapshot::new(
        (10, chain.hashes[10]),
        (29, chain.hashes[29]),
        (29, chain.hashes[29]),
    )
    .unwrap();
    index
        .scan(&mut chain, &old, Budget::default(), |_| {
            Ok(ControlFlow::Continue(()))
        })
        .unwrap();
    chain.reorg(5);
    assert!(matches!(
        index.scan(&mut chain, &old, Budget::default(), |_| Ok(
            ControlFlow::Continue(())
        )),
        Err(Error::Snapshot(_))
    ));
    assert_eq!(count(&index, 29), 0);
    let fresh = Snapshot::new(
        (12, chain.hashes[12]),
        (29, chain.hashes[29]),
        (29, chain.hashes[29]),
    )
    .unwrap();
    index
        .scan(&mut chain, &fresh, Budget::default(), |_| {
            Ok(ControlFlow::Continue(()))
        })
        .unwrap();
    assert_eq!(count(&index, 29), 36);
}

#[test]
fn provider_failure_identity_and_prefix_changes_do_not_advance_cursor() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let mut index = open(&path);
    let mut chain = Chain::new(3, 4);
    chain.fail = Some(chain.blocks[0][2]);
    assert!(matches!(run(&mut index, &mut chain), Err(Error::Provider)));
    assert_eq!(chain.reads, 2);
    assert_eq!(count(&index, 2), 0);
    chain.fail = None;
    chain.blocks[0].swap(0, 1);
    assert!(matches!(
        run(&mut index, &mut chain),
        Err(Error::Integrity(_))
    ));
    chain.blocks[0].swap(0, 1);
    chain.wrong = true;
    assert!(matches!(
        run(&mut index, &mut chain),
        Err(Error::Integrity(_))
    ));
    chain.wrong = false;
    run(&mut index, &mut chain).unwrap();
    assert_eq!(count(&index, 2), 12);
}

#[test]
fn conflicting_spends_and_duplicate_ids_fail_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(2, 2);
    let first = chain.records[&chain.blocks[0][0]].clone();
    let conflict = support::record(500, Some(&first));
    chain.blocks[1][0] = conflict.txid();
    chain.records.insert(conflict.txid(), conflict);
    assert!(matches!(
        run(&mut index, &mut chain),
        Err(Error::Integrity(_))
    ));
    assert_eq!(count(&index, 1), 2);
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(1, 2);
    chain.blocks[0][1] = chain.blocks[0][0];
    assert!(matches!(
        run(&mut index, &mut chain),
        Err(Error::Integrity(_))
    ));
    assert_eq!(chain.reads, 0);
}

#[test]
fn snapshots_hide_future_spends_and_rows_support_nested_queries() {
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(3, 1);
    run(&mut index, &mut chain).unwrap();
    let outpoint = Outpoint::new(chain.blocks[0][0], 0);
    assert!(index.view(0).spend(outpoint).unwrap().is_none());
    assert_eq!(
        index.view(1).spend(outpoint).unwrap(),
        Some((chain.blocks[1][0], 0))
    );
    let (cursor, row) = index.view(2).next(None).unwrap().unwrap();
    assert_eq!(cursor, (0, 0));
    assert_eq!(index.view(2).get(chain.blocks[0][0]).unwrap(), Some(row));
    assert!(index.view(2).raw(chain.blocks[0][0]).unwrap().is_some());
    assert_eq!(index.view(2).next(Some(cursor)).unwrap().unwrap().0, (1, 0));
}

#[test]
fn reorg_yields_before_rollback_and_shorter_tip_invalidates_pin() {
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(100, 1);
    run(&mut index, &mut chain).unwrap();
    let old = chain.snapshot();
    chain.reorg(0);
    let mut saw = false;
    assert!(matches!(
        index.scan(&mut chain, &old, Budget::default(), |p| {
            saw = matches!(p, Progress::ReorgCheck { .. });
            Ok(ControlFlow::Break(()))
        }),
        Err(Error::Cancelled)
    ));
    assert!(saw);
    assert_eq!(count(&index, 99), 100);
    chain.hashes.truncate(20);
    assert!(matches!(
        index.scan(&mut chain, &old, Budget::default(), |_| Ok(
            ControlFlow::Continue(())
        )),
        Err(Error::Snapshot(_))
    ));
    assert_eq!(count(&index, 99), 0);
}

#[test]
fn discontinuity_prevents_completion() {
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(2, 1);
    chain.discontinuous = true;
    assert!(matches!(
        run(&mut index, &mut chain),
        Err(Error::Snapshot(_))
    ));
    assert_eq!(count(&index, 1), 1);
}

#[test]
fn independent_cancellation_prevents_provider_calls_and_commit_after_fetch() {
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(2, 2);
    let snapshot = chain.snapshot();
    let cancel = damp_indexer::Cancellation::default();
    cancel.cancel();
    // An empty provider would panic in tip if cancellation were checked too late.
    let mut empty = Chain::new(0, 0);
    assert!(matches!(
        index.scan_cancellable(&mut empty, &snapshot, Budget::default(), &cancel, |_| Ok(
            ControlFlow::Continue(())
        )),
        Err(Error::Cancelled)
    ));
    let cancel = damp_indexer::Cancellation::default();
    chain.cancel_on_read = Some(cancel.clone());
    assert!(matches!(
        index.scan_cancellable(&mut chain, &snapshot, Budget::default(), &cancel, |_| Ok(
            ControlFlow::Continue(())
        )),
        Err(Error::Cancelled)
    ));
    assert_eq!(chain.reads, 1);
    assert_eq!(count(&index, 1), 0);
    chain.cancel_on_read = None;
    run(&mut index, &mut chain).unwrap();
    assert_eq!(chain.reads, 5);
}

#[test]
fn actual_mid_scan_reorg_never_marks_the_replaced_block_complete() {
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(2, 2);
    chain.reorg_on_read = true;
    assert!(matches!(
        run(&mut index, &mut chain),
        Err(Error::Snapshot(_))
    ));
    assert_eq!(count(&index, 1), 0);
    run(&mut index, &mut chain).unwrap();
    assert_eq!(count(&index, 1), 4);
}

#[test]
fn rollback_bounds_block_deletion_and_all_views_hide_the_remaining_orphans() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index");
    let mut index = open(&path);
    let mut chain = Chain::new(1000, 1);
    run(&mut index, &mut chain).unwrap();
    chain.reorg(0);
    let snapshot = chain.snapshot();
    let result = index.scan(
        &mut chain,
        &snapshot,
        Budget::new(2, Duration::from_secs(30)).unwrap(),
        |p| {
            if let Progress::RollingBack {
                removed_transactions,
                removed_blocks,
            } = p
            {
                assert_eq!((removed_transactions, removed_blocks), (1, 1));
                Ok(ControlFlow::Break(()))
            } else {
                Ok(ControlFlow::Continue(()))
            }
        },
    );
    assert!(matches!(result, Err(Error::Cancelled)));
    let view = index.view(999);
    let first = chain.blocks[0][0];
    assert!(view.next(None).unwrap().is_none());
    assert!(view.get(first).unwrap().is_none());
    assert!(view.raw(first).unwrap().is_none());
    assert!(view.spend(Outpoint::new(first, 0)).unwrap().is_none());
    assert_eq!(count(&index, 999), 0);
    drop(index);
    let db = rusqlite::Connection::open(path.join("history.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        999
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM blocks WHERE complete=1", [], |r| r
            .get::<_, u32>(0))
            .unwrap(),
        999
    );
    drop(db);
    let mut index = open(&path);
    run(&mut index, &mut chain).unwrap();
    assert_eq!(count(&index, 999), 1000);
}

#[test]
fn rollback_elapsed_budget_yields_before_the_count_budget() {
    let temp = tempfile::tempdir().unwrap();
    let mut index = open(&temp.path().join("index"));
    let mut chain = Chain::new(10, 2);
    run(&mut index, &mut chain).unwrap();
    chain.reorg(0);
    let snapshot = chain.snapshot();
    let mut observed = false;
    assert!(matches!(
        index.scan(
            &mut chain,
            &snapshot,
            Budget::new(10_000, Duration::from_nanos(1)).unwrap(),
            |p| {
                if let Progress::RollingBack {
                    removed_transactions,
                    removed_blocks,
                } = p
                {
                    observed = true;
                    assert_eq!((removed_transactions, removed_blocks), (1, 0));
                    Ok(ControlFlow::Break(()))
                } else {
                    Ok(ControlFlow::Continue(()))
                }
            }
        ),
        Err(Error::Cancelled)
    ));
    assert!(observed);
}
