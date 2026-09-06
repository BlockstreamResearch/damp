# PGC equal-value confidential-payment policy PoC

## Status and boundary

This is an isolated research policy. It does not modify or replace the DAMP
blacklist policy, and no existing DAMP contract invokes it. The implementation
is `amp_core::pgc_policy`; deterministic interoperability data is in
`fixtures/pgc-equal-vectors.json`.

The construction adapts the shared-randomness `Sigma_equal` protocol from
section 5.2.1 of Chen, Ma, Tang, and Au, *PGC: Decentralized Confidential
Payment System with Auditability*, IACR ePrint 2019/319, revision dated
2025-09-06. The cited section, Lemma 5.5, and Theorem 5.1 were re-verified
against the [official PDF](https://eprint.iacr.org/2019/319.pdf) on
2026-09-02. It uses
additive notation on secp256k1:

- public keys `pk_s`, `pk_r`;
- ciphertext `(X_s, X_r, Y)`;
- a caller-supplied value commitment `C`;
- witness `(r, v)`; and
- fixed base generator `G` and independent message generator `H`.

The proved relation is exactly

```text
X_s = r * pk_s
X_r = r * pk_r
Y   = r * G + v * H
C   = Y
```

The last equality ties the encrypted value to the commitment supplied by the
host. The Fiat--Shamir transcript also contains a ledger network identifier
and a 32-byte `transaction_binding`.

`C` is required to be byte-for-byte the same curve point as `Y`; it is not a
second, independently blinded Bitcoin-side Pedersen commitment. Supporting a
different commitment basis or blinding factor would require another proof
relation.

The implementation rejects an all-zero transaction binding so a default-filled
context cannot silently become an unbound proof. This is only a misuse guard,
not evidence that a nonzero digest was derived correctly by the host.

Bitcoin has no native confidential-value field. Consensus enforcement therefore
requires a surrounding Bitcoin/Simplicity covenant to (1) place or commit `C`
at an unambiguous transaction location and (2) derive `transaction_binding`
from the actual transaction/template plus that location and semantic policy.
The Rust module cannot establish either host fact; it only proves consistency
for the bytes it receives. Passing an arbitrary digest or commitment provides
no on-chain binding.

This cannot hide native BTC output amounts, which remain consensus-visible.
At most it can protect an application-layer amount represented by covenant state
while ordinary BTC serves as a visible carrier/fee value. A complete design must
specify that state machine and prevent encrypted-state inflation; this PoC does
neither.

The `network` field enumerates Bitcoin mainnet, testnet, signet, and regtest,
Liquid mainnet and testnet, and Elements regtest. Network identity is therefore
bound by the version-1 transcript without pretending a Liquid testnet proof is
a Bitcoin-testnet proof.
Liquid outputs already carry Pedersen value commitments under a different
generator and blinding factor; tying `Y` to such a commitment needs an
additional equal-value relation across the two bases, which this PoC does not
implement.

For the reproducible host-side transaction gate, the binding is

```text
SHA256_tagged(
  "simplicity-amp/pgc-equal/transaction-binding/v1",
  network_code || display_txid_bytes || output_index_be32
)
```

The versioned hash tag supplies the policy identifier and version. The
transaction identifier commits to the transaction and its spent outpoints; the
output index identifies the state slot. `derive_transaction_binding` implements
this profile. The host must still obtain the transaction from the selected
network, require confirmation when its policy needs finality, and establish the
application meaning of the selected output. This digest does not make the PGC
proof an on-chain verifier.

## Proof

For fresh nonces `(a, b)`, the prover publishes

```text
A_s = a * pk_s
A_r = a * pk_r
B   = a * G + b * H
```

It computes the nonzero Fiat--Shamir challenge `e` and responses

```text
z_r = a + e*r mod n
z_v = b + e*v mod n
```

The verifier checks

```text
z_r * pk_s = A_s + e*X_s
z_r * pk_r = A_r + e*X_r
z_r * G + z_v*H = B + e*Y
Y = C
```

This proves knowledge of one plaintext and one reused encryption randomness
consistent across the two recipients and the commitment. The guarantees
separate as follows:

- Special soundness is unconditional: two accepting transcripts with distinct
  challenges yield `r = (z_r - z_r') / (e - e')` and
  `v = (z_v - z_v') / (e - e')` satisfying the relation. Knowledge soundness of
  the non-interactive proof holds in the random-oracle model by rewinding.
- The extracted witness is unique because a twisted-ElGamal ciphertext is
  perfectly binding: `X_s = r * pk_s` fixes `r`, and `Y - r*G = v*H` then fixes
  `v` in the prime-order group. No discrete-log assumption is needed for that
  uniqueness.
- The interactive protocol is perfect special honest-verifier zero-knowledge.
  Because the complete statement is hashed and responses are unique given the
  commitments and challenge, the Fiat--Shamir proof is zero-knowledge and
  non-malleable in the random-oracle model (Faust, Kohlweiss, Marson, and
  Venturi, INDOCRYPT 2012).
- Confidentiality of `v` against parties holding neither `sk_s` nor `sk_r` is
  the IND-CPA property of the paper's 1-plaintext/2-recipient twisted ElGamal,
  which relies on the divisible DDH assumption (Theorem 5.1 in the pinned
  2025-09-06 ePrint revision).
- The unknown discrete logarithm `log_G(H)` matters when a host treats `C = Y`
  as a standalone Pedersen commitment, for example in a later range or balance
  proof: binding of that view needs `log_G(H)` to be unknown.

This PoC has not received a formal third-party audit.

## Parameters and canonical encodings

`G` is the standard secp256k1 generator. `H` is derived reproducibly by tagged
SHA-256 try-and-increment from `simplicity-amp/pgc-equal/h-generator/v1`, taking
the first valid compressed point and requiring `H != G`. Its compressed encoding
is:

```text
02ed9d2dd95c5e81889c23622b7c77b92a47c7d371f544d83645eee7e7b630d0bd
```

The derivation is a transparent PoC parameter choice, not a standardized
hash-to-curve suite. For each counter the search tests only prefix `02`, so `H`
always has an even `y` coordinate. Security assumes nobody knows `log_G(H)`.

Every point is exactly 33-byte compressed SEC1 (`02/03 || x`), parses as a
non-infinity secp256k1 point, and reserializes byte-for-byte. Every scalar is
exactly 32-byte big-endian and strictly less than the secp256k1 group order;
responses may be zero. Encryption randomness and internally derived proof
nonces must be nonzero. Decoders reject alternate lengths, uncompressed points,
invalid curve points, non-canonical scalars, unknown versions/networks, and
trailing bytes.

Statement encoding (265 bytes):

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 1 | version (`01`) |
| 1 | 1 | network (`00` Bitcoin mainnet, `01` Bitcoin testnet, `02` Bitcoin signet, `03` Bitcoin regtest, `04` Liquid mainnet, `05` Liquid testnet, `06` Elements regtest) |
| 2 | 32 | transaction binding |
| 34 | 33 | sender public key |
| 67 | 33 | receiver public key |
| 100 | 33 | sender handle `X_s` |
| 133 | 33 | receiver handle `X_r` |
| 166 | 33 | ciphertext body `Y` |
| 199 | 33 | host value commitment `C` |
| 232 | 33 | message generator `H` |

Proof encoding (163 bytes):

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 33 | `A_s` |
| 33 | 33 | `A_r` |
| 66 | 33 | `B` |
| 99 | 32 | `z_r` |
| 131 | 32 | `z_v` |

## Fiat--Shamir transcript

The challenge preimage is the complete canonical statement encoding followed
by `A_s || A_r || B || counter_be32`. The hash is BIP340-style tagged SHA-256:

```text
tag = "simplicity-amp/pgc-equal/challenge/v1"
SHA256(SHA256(tag) || SHA256(tag) || preimage)
```

The digest is interpreted as a big-endian integer and reduced modulo `n`. The
counter starts at zero and increments only if the result is zero. All semantic
context must be committed inside `transaction_binding`; there are no omitted or
implicitly serialized fields.

Proof nonces use the separate tag `simplicity-amp/pgc-equal/nonce/v1` and are
derived internally from a role byte, the complete witness, 32 bytes of caller
auxiliary randomness, the complete statement encoding, and a nonzero-retry
counter. Binding them to the full statement prevents nonce reuse across
different challenges even if caller entropy repeats. Production callers should
still provide fresh CSPRNG output for hedging.

## What is not proved

This module deliberately does **not** provide:

- a range proof for `v`, so `v` is a scalar rather than a proven nonnegative
  Bitcoin amount;
- sender solvency, input/output balance, conservation, or absence of inflation;
- ciphertext decryption or receiver scanning;
- transaction authorization, signatures, replay protection beyond the host
  binding, or ownership of either public key;
- Bulletproof composition, regulation/audit proofs, or the full PGC account
  protocol;
- a Bitcoin or Simplicity consensus program; or
- an audited end-to-end constant-time prover. Secret response multiplication
  and addition use libsecp256k1-zkp, but the surrounding PoC API and control flow
  have not received side-channel review.

The scalar helper branches on zero secret operands, so proof generation can
reveal whether `v = 0` through timing. Scalar comparisons and the
hash-to-scalar reduction use variable-time byte comparisons. The witness,
internally derived nonces, auxiliary-randomness copy, and nonce preimage buffer
are now zeroized on drop. The public scalar type remains `Copy` because proof
responses are public, and third-party scalar operations can still leave
compiler- or library-created temporaries. A production implementation still
needs a complete side-channel and memory-hygiene audit and should enforce its
intended nonzero/range policy.

## Checks

The core tests cover valid round trips, four deterministic vectors, transaction
and network transcript binding, transaction-binding derivation,
commitment/ciphertext mismatch at decode and verification, response
and proof-commitment mutation, H substitution, zero responses, invalid point
encodings, non-canonical scalars, trailing bytes, and zero encryption randomness.
The vector suite includes full-width scalars, `v = 0`, equal sender/receiver
keys, Liquid testnet, and Elements regtest.
Run them with:

```bash
cargo test -p simplicity-amp-core --lib
```

An independent pure-Python re-derivation of the fixture, written only from this
document and sharing no code with the Rust module, is in
`scripts/pgc-equal-crosscheck.py`. It exits nonzero if any re-derived statement
or proof byte differs from the fixture or if any negative control verifies:

```bash
python3 scripts/pgc-equal-crosscheck.py
```

## Reproducible Liquid testnet gate

`scripts/validate-pgc-liquid-testnet.sh` fetches a public Liquid testnet
transaction from Blockstream Esplora, verifies its confirmation and selected
confidential output, then runs both the Rust implementation and the independent
Python implementation over the bound vector. On 2026-09-02 it passed with:

- network: Liquid testnet (`05`);
- transaction:
  [`39faa5b530fdaa36d3791abae6694c16513eaec0378be9f0a040d3c17d79dc6f`](https://blockstream.info/liquidtestnet/tx/39faa5b530fdaa36d3791abae6694c16513eaec0378be9f0a040d3c17d79dc6f);
- selected output: `2`, address
  `tex1qqqv84egs2crnntt0aqh2tf5tve5xf738zme68j`, value commitment
  `0838c1ec7d277f4dc114f7a72ec578a6da75bafdca40f46c9175151116bf82a581`;
- confirmation: block `2598267`, hash
  `0b0ffbda7b7b855917677f072c5ea6e5bc081189c85f6ea53f45121a3293714c`;
- transaction binding:
  `0b377118ef2ecd980bf66e170ef9b1ad6aa8f6106c854b38e5e6a2a543a00c25`;
- statement SHA-256:
  `b9002068800b83aeed0d0700041aaa799ab4868d3aaa69297af65868651d769d`;
- proof SHA-256:
  `28713475623e7cf65d05278ce13a74f093f88c53579a0860a5cc7ef35290f548`.

This is the strongest end-to-end claim the present PoC supports: a proof was
generated and verified off-chain for a host binding derived from a real,
confirmed Liquid testnet transaction and output. No PGC proof was placed in or
enforced by the transaction, and the PGC commitment is not tied to the Liquid
output's native Pedersen commitment. A cross-base proof and covenant verifier
remain future protocol work.

## References

- Yu Chen, Xuecheng Ma, Cong Tang, and Man Ho Au. “PGC: Decentralized
  Confidential Payment System with Auditability.” Cryptology ePrint Archive,
  Report 2019/319, revision 2025-09-06.
  <https://eprint.iacr.org/2019/319>
- Sebastian Faust, Markulf Kohlweiss, Giorgia Azzurra Marson, and Daniele
  Venturi. “On the Non-malleability of the Fiat-Shamir Transform.” INDOCRYPT
  2012, pp. 60-79. <https://doi.org/10.1007/978-3-642-34931-7_5>
