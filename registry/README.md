# Public registry

This directory contains public, reviewable DAMP data. Deployment manifests are
immutable. Policy snapshots are immutable and stored at
`policies/{deploymentId}/{sha256(verifierScriptPubkey)}.json`.
Holder wallets share a standard confidential address. Its public blinding key
encodes the holder identity needed to validate the selected covenant script.

Notes attached to blacklist entries are non-consensus metadata. Consensus uses
only the exact `txid:vout` pair. Wallets resolve the current snapshot directly
from the live verifier script, require byte-identical data from the configured
default branch, and revalidate it before signing. The governance spend occurs
only after publication and becomes active only after confirmation.

The manifest never contains a mutable verifier-program hash. Each snapshot
records its own depth-specific verifier leaf and resulting two-leaf anchor
script. Every new deployment starts at depth 4; issuer governance may move to
depth 5 or 6 as the blacklist grows.

GitHub credentials are never stored by the application. Publishing uses a
repository-scoped GitHub App device flow, with the token retained in memory for
the current page session only.
