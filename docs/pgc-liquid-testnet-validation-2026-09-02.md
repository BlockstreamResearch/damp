# PGC host-side Liquid testnet validation — 2026-09-02

## Result

Pass. The final PGC proof-of-concept implementation generated and verified an
equal-value proof whose standardized host binding was derived from a real,
confirmed Liquid testnet transaction and output. The independent Python
implementation reproduced the statement and proof byte-for-byte, and all
negative controls rejected.

This gate is deliberately host-side. No transaction carried or enforced the
PGC proof, and the PGC commitment was not proved equal to Liquid's native
cross-base Pedersen value commitment. No transaction was broadcast, no funds
were spent, and no mnemonic, private key, wallet identifier, or other secret
was used or recorded.

## Public network evidence

- Network: Liquid testnet, PGC network code `05`.
- Esplora endpoint: `https://blockstream.info/liquidtestnet/api`.
- Transaction:
  [`39faa5b530fdaa36d3791abae6694c16513eaec0378be9f0a040d3c17d79dc6f`](https://blockstream.info/liquidtestnet/tx/39faa5b530fdaa36d3791abae6694c16513eaec0378be9f0a040d3c17d79dc6f).
- Confirmation: block height `2598267`, block hash
  `0b0ffbda7b7b855917677f072c5ea6e5bc081189c85f6ea53f45121a3293714c`,
  block time `2026-09-01T08:45:07Z`.
- Selected output: `2`.
- Address: `tex1qqqv84egs2crnntt0aqh2tf5tve5xf738zme68j`.
- Script pubkey: `001400187ae510560739ad6fe82ea5a68b666864fa27`.
- Asset:
  `144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49`.
- Confidential value commitment:
  `0838c1ec7d277f4dc114f7a72ec578a6da75bafdca40f46c9175151116bf82a581`.

## Proof evidence

The implementation derives

```text
transaction_binding = SHA256_tagged(
  "simplicity-amp/pgc-equal/transaction-binding/v1",
  05 || display_txid_bytes || 00000002
)
```

with result
`0b377118ef2ecd980bf66e170ef9b1ad6aa8f6106c854b38e5e6a2a543a00c25`.
The test-only witness and auxiliary input are deterministic public fixture
values, not wallet secrets.

- Statement length: 265 bytes.
- Statement SHA-256:
  `b9002068800b83aeed0d0700041aaa799ab4868d3aaa69297af65868651d769d`.
- Proof length: 163 bytes.
- Proof SHA-256:
  `28713475623e7cf65d05278ce13a74f093f88c53579a0860a5cc7ef35290f548`.
- Independent Python challenge:
  `400317f4d8d5c5b50cbc5f1364715df7f24f45a4ac6fd3ed72a14f696e3119d2`.

The full canonical bytes are in the
`liquid-testnet-confirmed-output-v-zero` entry of
`fixtures/pgc-equal-vectors.json`.

## Reproduction

Run:

```bash
./scripts/validate-pgc-liquid-testnet.sh
```

The script fails closed unless Esplora returns the expected transaction,
confirmation, block, output, address, and confidential commitment. It then runs
the Rust fixture test and the independent Python cross-check. Its terminal line
on success is:

```text
PGC host-side Liquid testnet validation passed; no on-chain PGC enforcement was exercised.
```

## Completion boundary

This evidence closes the PGC PoC's specified Liquid testnet gate. It supports
the claim that the proof implementation can bind to a confirmed Liquid testnet
transaction and selected output and verify consistently in two independent
implementations. It does not support claims of confidential native Bitcoin
amounts, Liquid native-commitment equality, value range or conservation,
transaction authorization, consensus enforcement, production readiness, or a
third-party audit.
