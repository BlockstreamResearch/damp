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

For regtest wallet use, configure your chain's public Esplora URL in the browser console, then reload. Reporting uses Elements RPC directly and needs no Esplora.

```js
localStorage.setItem("simplicity-damp:regtest-esplora", "http://127.0.0.1:3002/api")
```

## Signed reports

```sh
cargo build --release -p damp-report -p damp-indexer -p simplicity-damp-signer --bin damp-report --bin damp-indexer --bin damp-audit
./target/release/damp-report init "$HOME/.damp-audit"
```

Copy the issuer's public manifest to `deployment.json`. The new private `~/.damp-audit/config.json` defaults to Liquid testnet's public Esplora, port 8778, and browser origin `http://127.0.0.1:5173`. Public Esplora sees queried transaction IDs and supplies trusted inclusion data. A local node is optional for testnet and required for regtest. To use one, replace only the config's `provider` object:

```json
{"kind":"rpc","port":18884,"cookie":"/absolute/node/datadir/liquidregtest/.cookie"}
```

Use the actual RPC port and cookie path. For testnet the cookie is under `liquidtestnet`. The node must be unpruned, have `txindex=1`, and finish chain and transaction-index sync. RPC stays on 127.0.0.1. Keep the config and cookie owner-only. The service checks the network and refuses mismatches.

Gather public bootstrap and reissuance transactions, with no wallet or audit key:

```sh
./target/release/damp-report prepare-export "$HOME/.damp-audit/config.json" deployment.json issuer-export
```

Choose one credential export method:

- In the browser, connect the deployment's issuer signer, open Report → Export issuer audit credentials, select all `issuer-export/*.hex` files, and download `audit-credentials.json`. Move it into `~/.damp-audit/`, run `chmod 600 ~/.damp-audit/audit-credentials.json`, and delete extra download copies.
- Offline, use the issuer's existing owner-only mnemonic file. The first path below is that file, never the phrase itself. Copy the resulting restricted file to the service's private directory if exporting on another computer.

```sh
./target/release/damp-audit export-audit-credentials /private/issuer-wallet liquid-testnet issuer-export/request.json "$HOME/.damp-audit/audit-credentials.json"
./target/release/damp-report serve "$HOME/.damp-audit/config.json"
```

Use `elements-regtest` instead of `liquid-testnet` for regtest. The export contains deployment-scoped audit and report keys, an issuer certificate, and issuer output openings. It can reveal amounts and sign reports, but cannot spend. Never publish it or send it to a remote service. Refresh it after issuer reissuance. Stop your report service before gathering refreshed export inputs, then restart with the new credentials. The CLI refuses to overwrite a file; retain the old export privately and choose a new output filename when refreshing, then update `credentials` in the config.

In Report, enter `http://127.0.0.1:8778/report` and the value from the private `~/.damp-audit/access-token` file. Generate, inspect completeness and gaps, then download signed JSON. Requesting a report needs no browser signer. Verify a downloaded file independently:

```sh
./target/release/damp-report health "$HOME/.damp-audit/config.json"
./target/release/damp-report verify deployment.json downloaded-report.json
./target/release/damp-indexer token-reset "$HOME/.damp-audit/access-token"
```

The token-reset command replaces a lost token without the old token or mnemonic. The server reloads it and cancels retained jobs. For a hosted UI, set `origin` to its exact HTTPS origin without the project path. If browser local-network permission blocks Pages, use the local UI. Do not weaken Host, Origin or bearer checks. Secrets stay in files or page memory, never URLs or logs.

Authenticated `GET /health` reports configuration and active progress. Provider readiness is checked when a report starts. Node sync, indexing and confidential recovery are separate phases; only the signed snapshot establishes completeness. Cancellation keeps committed public history and releases the old snapshot. A new request pins a fresh snapshot; crash/restart resumes the interrupted pin. Recovery restarts; reports are kept only in memory and expire after two minutes without polling. One report runs at a time. Cancellation waits for the current bounded provider or recovery operation to return, up to 45 seconds for a provider call.

`indexMaxMiB` limits persistent history, default 10240 MiB. Report data is limited to 3 MB. Missing history, openings, resource exhaustion or a changed snapshot cannot produce a complete report. Preserve old index directories; use a new `indexDir` when deployment, provider, network, decoder or schema differs. The decoder identity hashes the executable, so rebuilding or replacing the binary may require a new index directory. Chain inclusion trusts the configured provider, with block-link and applicable outspend checks, not SPV proofs.

The exported child keys rely on keeping DAMP derivation-subtree extended public keys private. Do not add exports of those xpubs; a leaf secret plus its parent xpub can reveal sibling keys. The ordinary wallet descriptor uses a separate derivation subtree.

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
