# Public registry

The registry publishes immutable deployment manifests and policy snapshots.
It contains no signing keys, audit secrets or private output openings.

## Record paths

- `registry/deployments/{deploymentId}.json` identifies a deployment. Its manifest binds
  the network, asset IDs, issuer and audit keys, initial supply, genesis anchor
  and fixed contract commitments. Managed supply also records the reissuance
  token and entropy; fixed supply sets both fields to `null`.
- `registry/policies/{deploymentId}/{scriptHash}.json` describes one verifier anchor.
  `scriptHash` is SHA-256 of the verifier script bytes, not its hex text. The
  snapshot contains the blacklist, Merkle commitment, tree depth, executable
  verifier commitment and complete anchor script.

Initial policy sequence zero has no parent. Every successor identifies both
its parent policy root and parent verifier script hash. Wallets follow those
links to authenticate policy history. A published snapshot alone does not
change policy; the confirmed governance transaction selects the active anchor.

Blacklist entries identify exact `txid:vout` pairs. Notes are public metadata
and do not affect the Merkle commitment. Trees at depths 4, 5 and 6 hold at most
16, 32 and 64 entries. Bootstrap starts at depth 4.

## Publish and verify

Paths are relative to the repository root. The official registry lives at
[`BlockstreamResearch/damp`, `main/registry`](https://github.com/BlockstreamResearch/damp/tree/main/registry).
The app discovers manifests from that branch's `registry/deployments` directory
through the GitHub API. It does not bundle deployment IDs. Custom GitHub
registries use the same directory layout on their default branch.

Download the JSON from the issuer UI and publish those exact bytes at the
displayed registry path. The configured registry uses `VITE_GITHUB_REGISTRY_REF`,
which defaults to `main`; a custom registry uses its GitHub default branch.
The app checks the published bytes before allowing the governance spend. It
does not log in to GitHub or store GitHub credentials.

Canonical files use the app's field order, two-space JSON indentation and one
trailing newline. Do not reserialize or hand-edit a downloaded record. The
deployment ID is computed from the manifest's bound fields, not from the JSON
file's text.

The [deployment schema](schemas/deployment.schema.json) and
[snapshot schema](schemas/policy-snapshot.schema.json) check JSON structure.
Rust validation also checks curve points, numeric bounds, paired fields and
recomputed policy commitments. Before signing, the signer checks the current
contract bundle, compiled programs and selected transaction inputs. Schema
validation alone does not establish on-chain policy or ownership.

Run `pnpm schema:test` from the repository root to check both synthetic regtest
fixtures. Run `cargo test --workspace` for registry, source-bundle and signer
checks. The fixtures are deterministic test inputs, not network receipts.

Run `pnpm registry:check` to check the live official registry directory and the
canonical bytes of each listed manifest. CI and Pages run this network check
separately from the mocked unit tests. It does not verify chain state or key
ownership. GitHub API limits and outages can prevent discovery; the app reports
those failures without falling back to an old catalog.
