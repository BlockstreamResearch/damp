# Audit-proof optimization experiment

`probe.py` and `probe-result.json` preserve an algebraic experiment, not a
replacement protocol or a security proof. The associated Rust cost examples
and measured fixtures are in `examples/` and `docs/pgc-phase-zero/`.

The linear optimization reduced some cryptographic operations but increased
the measured integrated cost by approximately 6%, so the implementation
retains the baseline. Generalizing a standalone algebraic identity to the
full transaction verifier requires separate correctness and security review.
