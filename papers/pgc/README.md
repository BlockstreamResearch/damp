# Native confidential audit proofs

This manuscript describes DAMP's proof linking a native Elements value
commitment to an issuer audit handle. It covers Simplicity verification,
authenticated recovery data and bounded signed reporting.

Reference implementation:

- [Native contract checks](../../simf/lib/audit.simf).
- [Native proof and recovery code](../../crates/damp-core/src/native_audit/mod.rs).
- [Signer execution tests](../../crates/damp-signer/tests/lifecycle.rs).

Run `make -C papers/pgc` from the repository root to create `out/main.pdf` here.
