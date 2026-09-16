# DAMP public history index

Use the [root guide](../../README.md#signed-reports) to run the Rust HTTP report service. No wallet or audit key is required for public indexing.

```sh
cargo build -p damp-indexer
cargo test -p damp-indexer
./target/debug/damp-indexer --help
```

The library stores verified public transactions and resume positions in SQLite. It checks transaction IDs, block links, pinned snapshots and reorgs. Cancellation preserves committed history. macOS and Linux are supported.

`damp-indexer session` is a JSON-lines pipe for native clients. It does not start an HTTP server or a node. Integration details and resource bounds are in [PROTOCOL.md](PROTOCOL.md). The shipped `damp-report` service calls the library directly.
