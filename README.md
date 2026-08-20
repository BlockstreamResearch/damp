# Simplicity AMP v0.1

Research software for blacklist-regulated assets on Liquid testnet and Elements
regtest. Liquid mainnet is intentionally unsupported.

## Protocol

The verifier anchor is a two-leaf Taproot tree under the standard NUMS internal
key:

- The transfer leaf preserves the exact verifier asset, one-unit amount, and
  current script at input/output 0. It authenticates a holder at input 1,
  verifies blacklist non-membership for every regulated input, and confines
  every regulated output to the user covenant.
- The governance leaf authenticates the issuer and preserves the verifier asset
  and amount, but permits a successor script for policy upgrades, recovery, or
  deliberate shutdown.

The only policy is a canonical sorted Merkle set of exact outpoints keyed by
`SHA256(consensus_txid || big_endian(vout))`. Verifier variants D4, D5, and D6
support 16, 32, and 64 entries. Deployments start at D4 and move to the smallest
larger variant only when needed. The PoC supports at most ten regulated inputs
and ten regulated outputs per transfer.

The policy digest commits, with domain separation, to protocol version, depth,
set root, and entry count. Entry notes are registry metadata and do not affect
consensus commitments.

## Registry and application

Immutable manifests contain deployment-wide facts. Immutable snapshots contain
the depth-specific verifier leaf and resulting script. Snapshots are stored at
`policies/{deploymentId}/{sha256(verifierScriptPubkey)}.json`, so wallets resolve
policy from the live anchor rather than mutable registry state.

The web app persists public deployments locally and scopes anchor, policy, UTXO,
draft, and receive-record data by the selected deployment ID. A standalone Rust
AMP Signer SDK owns bootstrap, receive, transfer, policy-update, and reissuance
validation. It uses LWK for mnemonic derivation, SLIP77, and ordinary wallet
signing, compiles to WebAssembly, and keeps the recovery phrase in memory only.
The browser supplies chain data through Esplora but never executable Simplicity
source.

## Reproducible build

Simplex 0.0.9 and `simplicityhl-std` revision
`53b06722830fd85150389976e6b28ea26cc037f7` are pinned. Prepare the standard
library, generate ignored artifacts, then run the checks:

```bash
./scripts/prepare-simplex-std.sh
simplex build
cargo test --workspace --lib --test protocol
cargo check -p simplicity-amp-signer --target wasm32-unknown-unknown
pnpm install --frozen-lockfile
pnpm wasm
pnpm test
pnpm typecheck
pnpm build
```

Run the Elements integration test with `./scripts/test-regtest.sh`; the wrapper
enables non-standard relay on Simplex's pinned Elements node while retaining full
consensus execution of TapSimplicity. Maximum-shape witness, cost, and deterministic
in-program padding values are recorded in
[`docs/benchmarks.md`](docs/benchmarks.md).
