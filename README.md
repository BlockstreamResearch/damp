# DAMP

Experimental regulated assets and confidential audit reports on Liquid testnet and Elements regtest. No mainnet or production custody. Browser profiles save disposable test mnemonics unencrypted.

## Run the browser

Use Rust 1.91+, Node.js 22, pnpm 10.17.1, wasm-pack and LLVM Clang with the wasm32 target. On macOS, install LLVM with `brew install llvm` and put it first with `export PATH="$(brew --prefix llvm)/bin:$PATH"`; Apple's Clang lacks that target. Run from the repository root.

```sh
rustup target add wasm32-unknown-unknown
pnpm install --frozen-lockfile
pnpm wasm
pnpm --dir apps/web dev --host 127.0.0.1 --port 5173 --strictPort
```

Open [the local UI](http://127.0.0.1:5173), import the deployment and policy, and connect a disposable signer to use Receive or Send. Type `NEW` in the recovery-phrase field to create one. Wait for wallet synchronization before funding or signing. Never put a mnemonic in a report field, URL, command argument or registry file.

The hosted Pages wallet needs no local process for ordinary testnet transfers. Pages cannot start a local node or report service. Issuers publish public manifests and policies using the [registry layout](registry/README.md).

For regtest, open **Regtest public provider** in deployment import and save your chain's browser-accessible Esplora API URL, using HTTPS or loopback HTTP. Get it from the operator of your Elements node. The report service can use the node's RPC directly; browser import and automatic credential discovery use Esplora.

## Signed reports

```sh
cargo build --release -p damp-report -p damp-indexer -p simplicity-damp-signer --bin damp-report --bin damp-indexer --bin damp-audit
./target/release/damp-report init "$HOME/.damp-audit"
```

The new private `~/.damp-audit/config.json` defaults to Liquid testnet's public Esplora, port 8778, and browser origin `http://127.0.0.1:5173`. In Report, select or import the issuer's public deployment, open **Export issuer audit credentials**, connect its existing issuer signer, then click **Discover and download credentials**. Public transactions are fetched and validated automatically. No wallet funding is needed.

To scan your own node instead of Esplora, configure [local Elements RPC](#local-elements-node) before starting the report service. For the hosted Pages UI, set `"origin": "https://blockstreamresearch.github.io"` in the service config, with no `/damp/`, hash route or trailing slash. Use `http://127.0.0.1:5173` for the local UI. Restart the report service after changing its config; a wrong origin produces a 403 and a browser CORS error.

```sh
./target/release/damp-report import-credentials "$HOME/.damp-audit/config.json" "$HOME/Downloads/audit-credentials.json"
rm "$HOME/Downloads/audit-credentials.json"
./target/release/damp-report serve "$HOME/.damp-audit/config.json"
```

Use the actual download filename. Import validates the scoped keys and issuer certificate, creates a mode-600 copy and refuses to overwrite files. Delete other download copies too. These credentials reveal amounts and sign reports but cannot spend; never publish them or send them to a remote service. Refresh after each issuer reissuance. Stop the service, set a new `credentials` filename in its config, repeat discovery/import, then restart. Keep old credentials private.

In Report, enter `http://127.0.0.1:8778/report` and the value from the private `~/.damp-audit/access-token` file. Generate, inspect completeness and gaps, then download signed JSON. Requesting a report needs no browser signer. To verify a downloaded file independently, save the issuer's public manifest as `deployment.json`:

```sh
./target/release/damp-report health "$HOME/.damp-audit/config.json"
./target/release/damp-report verify deployment.json downloaded-report.json
./target/release/damp-indexer token-reset "$HOME/.damp-audit/access-token"
```

The token-reset command replaces a lost token without the old token or mnemonic. The server reloads it and cancels retained jobs. If browser local-network permission blocks Pages, use the local UI. Do not weaken Host, Origin or bearer checks. Secrets stay in files or page memory, never URLs or logs.

Authenticated `GET /health` reports configuration and active progress. Provider readiness is checked when a report starts. Node sync, indexing and confidential recovery are separate phases; only the signed snapshot establishes completeness. Cancellation keeps committed public history and releases the old snapshot. A new request pins a fresh snapshot; crash/restart resumes the interrupted pin. Recovery restarts; reports are kept only in memory and expire after two minutes without polling. One report runs at a time. Cancellation waits for the current bounded provider or recovery operation to return, up to 45 seconds for a provider call.

`indexMaxMib` limits persistent history, default 10240 MiB. Report data is limited to 3 MB. Missing history, openings, resource exhaustion or a changed snapshot cannot produce a complete report. Preserve old index directories; use a new `indexDir` when deployment, provider, network, decoder or schema differs. The decoder identity hashes the executable, so rebuilding or replacing the binary may require a new index directory. Chain inclusion trusts the configured provider, with block-link and applicable outspend checks, not SPV proofs.

The exported child keys rely on keeping DAMP derivation-subtree extended public keys private. Do not add exports of those xpubs; a leaf secret plus its parent xpub can reveal sibling keys. The ordinary wallet descriptor uses a separate derivation subtree.

### Local Elements node

Install `elementsd` and `elements-cli` from the same current stable [Elements Core release](https://github.com/ElementsProject/elements/releases). Put both on `PATH` and check `elementsd -version` and `elements-cli -version`. The following starts a Liquid **testnet** archival node. Initial sync downloads the full chain and builds its transaction index; allow disk space and time for both. It needs no wallet or recovery phrase.

```sh
mkdir -m 700 "$HOME/.damp-elements-testnet"
elementsd -chain=liquidtestnet -datadir="$HOME/.damp-elements-testnet" \
  -daemonwait -server=1 -disablewallet -txindex=1 -prune=0 \
  -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport=18884 \
  -validatepegin=0
elements-cli -chain=liquidtestnet -datadir="$HOME/.damp-elements-testnet" -rpcport=18884 getblockchaininfo
elements-cli -chain=liquidtestnet -datadir="$HOME/.damp-elements-testnet" -rpcport=18884 getindexinfo
```

Create the directory once; reuse it and the same `elementsd` command on later starts. If you already run a node, use its actual archival data directory and RPC port. A pruned directory cannot supply old transactions; use a new directory and sync the full chain. `-validatepegin=0` skips Bitcoin peg-in validation for this testnet setup, so no Bitcoin node is required; the node trusts the chain's peg-in claims without independently checking Bitcoin. To validate peg-ins independently, follow the [Elements node guide](https://docs.liquid.net/docs/advanced-elements-node#enable-peg-in-validation).

Wait until `getblockchaininfo` shows `chain: liquidtestnet`, `pruned: false`, `initialblockdownload: false`, and matching `blocks`/`headers`. In `getindexinfo`, `txindex.synced` must be true and `best_block_height` must reach the chain height. Starting the process alone does not make reporting ready.

Print the cookie path with `printf '%s\n' "$HOME/.damp-elements-testnet/liquidtestnet/.cookie"`. While the report service is stopped, set its config's `provider` to the object below, using that absolute path. JSON does not expand `~` or `$HOME`. Set `"indexDir": "history-rpc"` to start a separate report index when switching from Esplora; preserve the old index.

```json
{"kind":"rpc","port":18884,"cookie":"/absolute/path/to/.damp-elements-testnet/liquidtestnet/.cookie"}
```

Run the node and report service as the same OS user. Keep the cookie and report config private with mode 600. Elements creates and rotates the cookie; use its path, never paste its contents into the browser. Once credentials are installed, start the report service in another terminal:

```sh
./target/release/damp-report serve "$HOME/.damp-audit/config.json"
```

The report service now scans blocks and transactions through local RPC, without Esplora. To obtain issuer credentials through this node too, use [offline export](#offline-export) before starting the service. Browser deployment import and automatic credential discovery still use Esplora; changing the report provider does not change the browser's provider.

Keep the node running while generating reports. Stop it cleanly when finished:

```sh
elements-cli -chain=liquidtestnet -datadir="$HOME/.damp-elements-testnet" -rpcport=18884 stop
```

For an existing regtest deployment, use the node that contains its chain, with `-chain=liquidregtest`, its own data directory and RPC port, and the cookie under `liquidregtest/.cookie`. A fresh regtest node has no history for an existing deployment. The report service rejects a network mismatch.

### Offline export

For an offline issuer signer or unavailable browser Esplora, save the issuer's public manifest as `deployment.json`. Gather public transactions through the provider in the service config, then export with the existing private issuer mnemonic file. The first path below is that file, never the phrase itself.

```sh
./target/release/damp-report prepare-export "$HOME/.damp-audit/config.json" deployment.json issuer-export
./target/release/damp-audit export-audit-credentials /private/issuer-wallet liquid-testnet issuer-export/request.json "$HOME/.damp-audit/audit-credentials.json"
```

Use `elements-regtest` for regtest. Alternatively, choose all generated `issuer-export/*.hex` files under Report → Export issuer audit credentials → Offline transaction files. Manual selection cannot establish complete history; missing inputs prevent a complete report. The CLI refuses to overwrite credentials.

## Protocol limits

Transfers need no issuer approval. Policies block exact outputs. Transfers support ten regulated inputs and outputs, with an amount cap of `2^63-1`. Issuance and issuer governance must keep every regulated balance explicit and locked behind `user.simf`; confidential L-BTC inputs can then pay fees directly. The issuer's governance branch can end this confinement and audited coverage. Old contract bundles and APIs are unsupported; updating the app does not upgrade deployed anchors.

## Check locally

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check -p simplicity-damp-signer --target wasm32-unknown-unknown
pnpm wasm
pnpm test
pnpm typecheck
pnpm schema:test
pnpm --dir apps/web build
```

`cargo test -p damp-report --test http` runs actual HTTP, recovery, signing and restart checks with synthetic transactions and an empty service PATH. To exercise the browser with disposable fixtures, run `cargo run -p damp-report --example synthetic -- /tmp/damp-report-fixture`, then use its config and manifest in the commands above. The fixture prints its RPC address and never broadcasts. `pnpm registry:check` is a separate live public-registry check.

To repeat the browser credential/download check with synthetic data:

```sh
cargo build -p damp-report -p simplicity-damp-signer --bin damp-report --bin damp-audit --example synthetic
pnpm --dir apps/web exec playwright install chromium
node apps/web/e2e/report.mjs
```

The check creates a new temporary fixture directory and an isolated browser profile, exports credentials through the UI, runs the real HTTP service, downloads a report and verifies it natively. It makes no external chain requests. Screenshots and a short evidence log remain in the printed temporary directory.

## Rebuild the contracts

Generated programs are committed under
`crates/damp-signer/artifacts/simf/`, so ordinary Rust builds need no compiler
download. To regenerate them, install Simplex v0.0.9 using the upstream
[Simplex installer](https://github.com/BlockstreamResearch/smplx/tree/master/simplexup).
Simplex 0.0.9 cannot pin Git revisions, so fetch the required standard-library
commit into a clean dependency directory:

```bash
revision=53b06722830fd85150389976e6b28ea26cc037f7
git init -q deps/simplicityhl-std
git -C deps/simplicityhl-std fetch -q --depth 1 https://github.com/BlockstreamResearch/simplicityhl-std.git "$revision"
git -C deps/simplicityhl-std checkout -q --detach FETCH_HEAD
test "$(git -C deps/simplicityhl-std rev-parse HEAD)" = "$revision"
simplex build
git diff --exit-code -- crates/damp-signer/artifacts/simf
cargo test -p simplicity-damp-core --test contract_bundle
```

The bundle identity hashes sorted authored paths and bytes, including comments.
Cargo tests check that identity; CI also rejects generated-program drift.
Fixed cryptographic domain tags and executable commitment tests are separate
checks. Simplex's unused Rust wrappers are not part of the application.
