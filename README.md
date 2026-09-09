# DAMP

DAMP is a Simplicity covenant for regulated assets on Liquid. Holders transfer
confidential amounts without issuer approval. The issuer can block specific
outputs and recover amounts for audit reporting.

This is experimental software for Liquid testnet and Elements regtest.
Mainnet is unsupported. Browser signer profiles store disposable test mnemonics
unencrypted. Do not use real funds or custody keys.

## How it works

A verifier anchor enforces the current policy and requires a native Sigma proof
for every regulated transfer output. The proof ties its Elements value
commitment to an issuer audit handle. The issuer's separate governance branch
can update policy or end audited coverage.

Policy entries identify exact transaction outputs, not people or whole wallets.
Transfers support up to ten regulated inputs and ten regulated outputs. The
application amount cap is `2^63-1`. Audit reports trust one configured chain
provider and disclose incomplete coverage.

The repository supports one current implementation. Old bundles and APIs are
not supported.

- [`simf/`](simf/) contains the authored contracts. Sigma verification is in
  [`lib/audit.simf`](simf/lib/audit.simf).
- [`crates/damp-core/`](crates/damp-core/) contains policy, registry and proof logic.
- [`crates/damp-signer/`](crates/damp-signer/) constructs and signs transactions,
  checks covenant execution and exposes native and WebAssembly interfaces.
- [`apps/web/`](apps/web/) is the wallet and issuer UI.

## Run and test

Use Rust 1.91 or later, Node.js 22, pnpm 10.17.1 and wasm-pack.

From the repository root:

```bash
rustup target add wasm32-unknown-unknown
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds the signer WebAssembly module before starting the UI.
Report generation requires a separately supplied, compatible loopback HTTP
endpoint. This repository includes the report client and signature verification,
not an HTTP report server. Registry publication is manual; the UI downloads
canonical JSON and checks the published bytes before proceeding.

Offline checks:

```bash
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

These commands do not establish a fresh network deployment or a browser download.

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
