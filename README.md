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
signing and compiles to WebAssembly. Every signer profile in the v0.1 web app is
an explicitly disposable **debug/test profile**: its recovery phrase is stored
unencrypted in versioned browser local storage so profiles can switch directly
and survive reloads without an unlock prompt. Never enter a production or
mainnet recovery phrase, and never use these profiles for custody. Liquid mainnet
remains unsupported. The browser supplies chain data through
Waterfalls and Esplora but never executable Simplicity source.

Liquid testnet wallet discovery is pinned to the public Waterfalls v4 testing
service at `waterfalls.liquidwebwallet.org`. The wallet sends only derived
unconfidential addresses—never its descriptor, mnemonic, private keys, or
SLIP77 secret—and obtains address history, UTXOs, confirmation/tip metadata,
and raw parent transactions from Waterfalls. Esplora is an explicit narrow
fallback because Waterfalls does not expose spent-by details and rejects
UTXO-only queries for histories above its configured cap; anchor traversal and
broadcast also remain Esplora operations. Elements regtest uses the locally
configured Esplora because there is no shared regtest Waterfalls service. The
public Waterfalls instance is intended for testing/development and has no
production uptime guarantee. One synchronization has a shared browser-safety
budget across both derivation branches and holder scripts: at most 256 examined
addresses, 512 provider requests, 64 fallback requests, 32 MB of response data,
10,000 history entries, 256 distinct parent transactions, and 45 seconds. A
limit or provider failure aborts all in-flight discovery work and preserves the
last good snapshot. For a paginated history, the
Esplora UTXO fallback is accepted only when its tip is unchanged before and
after the query, exactly equals the Waterfalls tip, and its complete outpoint
set equals the Waterfalls outputs that are not consumed by a verified spending
input. Each returned output's confirmation must also match Waterfalls history
evidence. Waterfalls raw transactions for every recorded spending input are
checked so the fallback cannot resurrect or omit a Waterfalls-proven output.
Waterfalls v4 full-history entries may intentionally omit their signed `v`
position (`vout + 1`, `-(vin + 1)`, or zero/omitted when undefined) and expose
confirmation time as `block_timestamp`. When a paginated history omits those
positions, the wallet reconstructs and verifies the address's exact outputs
and spends from bounded raw Waterfalls transactions before consulting Esplora.

New Liquid testnet deployments derive two signer funding addresses and link
them directly to the public L-BTC faucet. The native fee asset is selected by
the network, while the regulated and verifier asset IDs are derived by the
bootstrap issuance transaction. Bootstrap accepts ordinary fully confidential
faucet outputs after signer-owned unblinding, then returns fee change as two
internal wallet outputs whose L-BTC asset ID is explicit and whose values remain
confidential. Those normalized outputs satisfy the stricter AMP input format for
later transfers, policy updates, and reissuance. GitHub Pages builds read the public
`VITE_GITHUB_REGISTRY_REPO` setting for read-only registry verification. Registry
publication is intentionally manual: the app downloads canonical JSON, shows its
exact repository path, and enables the next operation only after the byte-identical
file is available from the repository's default branch. No GitHub client ID or
browser authorization is required.

The deployment selector reconciles published local records against the
configured registry repository's current default branch. Published records
removed from that branch are no longer selectable; a missing `deployments/`
directory represents an intentionally empty canonical registry.

Ordinary AMP transfers keep every regulated asset ID and amount explicit. The
holder covenant rejects confidential regulated inputs, while the verifier rejects
missing, zero, confidential, overflowing, or unequal regulated input/output totals.
Only unrelated wallet outputs such as confidential L-BTC change use value-only
blinding.

## Reproducible build

Simplex 0.0.9 and `simplicityhl-std` revision
`53b06722830fd85150389976e6b28ea26cc037f7` are pinned. Prepare the standard
library, deterministically regenerate the committed artifacts, then run the checks:

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
