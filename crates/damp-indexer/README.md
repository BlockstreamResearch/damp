# DAMP history indexer

This native Rust crate indexes public Elements transaction history for bounded
audit reports. It parses transactions locally, checks their calculated IDs, and
commits transaction facts and resume positions together in SQLite. Recovery and
report signing stay in the signer SDK and require separate restricted credentials.

```sh
cargo build -p damp-indexer
cargo test -p damp-indexer
```

macOS and Linux are supported. The indexer does not broadcast transactions or
start a network service.

## Local access tokens

Create a private directory, then generate a new service access token without
providing an old token or wallet key:

```sh
mkdir -m 700 "$HOME/.damp-audit"
cargo run -p damp-indexer -- token-create "$HOME/.damp-audit/access-token"
```

To replace a lost token:

```sh
cargo run -p damp-indexer -- token-reset "$HOME/.damp-audit/access-token"
```

The CLI writes 32 bytes of OS randomness as hex to an owner-only file. It prints
only a success message. Read the file locally when entering the token in a client.
`token-create` refuses an existing file. `token-reset` atomically replaces it and
also works when the file is missing. Neither operation reads the previous token.
Both reject public directories, symlinks and files with multiple hard links.

The consuming service must reload the token file before authorizing each request
to revoke the old token without a restart. A request already authorized before
replacement may finish. Token generation grants no wallet signing authority.

## Library interface

Implement `Provider` for the chosen transport, open `HistoryIndex` with a public
`Scope`, and pin a `Snapshot`. `scan` reports progress after bounded batches;
return `ControlFlow::Break` to stop. `scan_cancellable` also accepts a shared
`Cancellation` signal checked between provider calls and writes. Each transport
must bound response sizes and timeouts because a synchronous call cannot be
interrupted by the scanner. Defaults are 100 transactions and an elapsed-time
check after each transaction at five seconds. Snapshot and block metadata checks
can add several bounded transport calls before the next progress message.

`SnapshotView` exposes typed public rows, raw transactions and spend lookups for
complete blocks through one height. Its one-row cursor supports consumers that
must query other transactions while iterating. Cancelled scans retain committed
public facts. The caller can retain the pinned request for retry or call `finish`
to discard that pin.

Reorg reconciliation finds a retained common ancestor, hides orphan blocks and
deletes their transactions and block rows in resumable batches. A persistent
visibility boundary also survives a return to the former branch during cancellation.
Count and elapsed-time checks run between single-transaction or single-block
deletion statements. Snapshot hash
changes stop report completion. A signature still relies on the configured
provider for consensus validity and chain inclusion; this is not an SPV verifier.

Each private directory holds one deployment/network/genesis/provider/decoder
scope and one process lock. Use a new directory when that scope or the schema
changes. Schema 2 rejects older databases without migrating them. Only public
transaction data and public request identifiers belong in the index. Provider
identifiers must exclude authentication data.

The allowance limits the SQLite main database through `max_page_count`, including
reuse of free pages. The rollback journal needs additional temporary disk space.
The indexer checks free space before transaction writes and rollback batches;
filesystem exhaustion can still occur concurrently and SQLite rolls back the
failed transaction. Raising the allowance and reopening resumes from the last
commit. Public transaction JSON is limited to 16 MiB. Transaction encodings are limited to 4,000,000 bytes and block lists to
500,000 IDs. These are per-operation bounds, not total history limits.

## Local process interface

`damp-indexer session` reads and writes JSON lines through pipes. Each line is
limited to 32 MiB. No credentials are accepted by the index session. A client
first sends `open` with `directory`, `scope` and `max_bytes`, then uses `pin`,
`pending`, `scan`, `assert-snapshot`, `next`, `get`, `raw`, `spend` or `finish`.
`close` or EOF releases the process lock.

During a scan the process emits `call` messages for `tip`, `blockhash`,
`previous_block`, `txids` and `raw`. The client replies with `{"result": ...}` or
`{"error": true}`. `progress` messages require `{"continue": true}` to resume or
`{"continue": false}` to cancel. All provider decoding, consistency checks,
storage and history queries run in Rust. The transport only supplies chain bytes.

Completed commands return `{"result": ...}`. Failures return `error.kind` and a
bounded generic message. Provider errors are not echoed. Stopping the process
during a provider call or progress pause preserves the last SQLite commit.

Tests cover 350 blocks and 11,200 transactions, durable partial-block restart,
interrupted deep rollback, snapshot changes, storage exhaustion and page reuse,
native process integration, and local token creation/replacement. They use
synthetic chain fixtures and do not establish live-chain consensus validity.
