#!/usr/bin/env python3
"""Independent cross-check of `fixtures/pgc-equal-vectors.json`.

This script re-derives the PGC equal-value PoC vector from first principles
using only Python integers and `hashlib`. It shares no code with
`crates/amp-core/src/pgc_policy.rs`, so agreement between the two is evidence
that the Rust encodings, `H` derivation, hedged nonce derivation, Fiat--Shamir
challenge, response arithmetic, and verification equations match the
specification in `docs/pgc-confidential-policy-poc.md`.

It is a review artifact for the confidential-verifier paper, not a production
verifier: the arithmetic is variable-time and unoptimised.

Usage: python3 scripts/pgc-equal-crosscheck.py
Exit status 0 means every check passed.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)

VERSION = 1
NETWORK_CODES = {
    "bitcoin-mainnet": 0,
    "bitcoin-testnet": 1,
    "bitcoin-signet": 2,
    "bitcoin-regtest": 3,
    "regtest": 3,
    "liquid-mainnet": 4,
    "liquid-testnet": 5,
    "elements-regtest": 6,
}
CHALLENGE_TAG = b"simplicity-amp/pgc-equal/challenge/v1"
H_GENERATOR_TAG = b"simplicity-amp/pgc-equal/h-generator/v1"
NONCE_TAG = b"simplicity-amp/pgc-equal/nonce/v1"
TRANSACTION_BINDING_TAG = b"simplicity-amp/pgc-equal/transaction-binding/v1"
STATEMENT_LEN = 1 + 1 + 32 + 7 * 33
PROOF_LEN = 3 * 33 + 2 * 32

Point = tuple[int, int] | None

FAILURES: list[str] = []


def check(condition: bool, label: str) -> None:
    status = "ok  " if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        FAILURES.append(label)


def point_add(a: Point, b: Point) -> Point:
    if a is None:
        return b
    if b is None:
        return a
    (x1, y1), (x2, y2) = a, b
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        lam = (3 * x1 * x1) * pow(2 * y1, P - 2, P) % P
    else:
        lam = (y2 - y1) * pow(x2 - x1, P - 2, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def point_mul(k: int, point: Point) -> Point:
    k %= N
    result: Point = None
    addend = point
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


def compress(point: Point) -> bytes:
    if point is None:
        raise ValueError("cannot encode the point at infinity")
    x, y = point
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")


def decompress(encoded: bytes) -> Point:
    if len(encoded) != 33 or encoded[0] not in (2, 3):
        raise ValueError("not compressed SEC1")
    x = int.from_bytes(encoded[1:], "big")
    if x >= P:
        raise ValueError("x-coordinate not reduced")
    y_sq = (pow(x, 3, P) + 7) % P
    y = pow(y_sq, (P + 1) // 4, P)
    if y * y % P != y_sq:
        raise ValueError("x is not on the curve")
    if (y & 1) != (encoded[0] & 1):
        y = P - y
    return (x, y)


def scalar_from_bytes(encoded: bytes) -> int:
    if len(encoded) != 32:
        raise ValueError("scalar must be 32 bytes")
    value = int.from_bytes(encoded, "big")
    if value >= N:
        raise ValueError("scalar is not canonical")
    return value


def tagged_hash(tag: bytes, message: bytes) -> bytes:
    tag_hash = hashlib.sha256(tag).digest()
    return hashlib.sha256(tag_hash + tag_hash + message).digest()


def derive_h() -> tuple[Point, int]:
    """Try-and-increment exactly as documented: prefix 0x02 on the tagged digest."""
    for counter in range(2**32):
        digest = tagged_hash(H_GENERATOR_TAG, counter.to_bytes(4, "big"))
        try:
            return decompress(b"\x02" + digest), counter
        except ValueError:
            continue
    raise RuntimeError("unreachable")


def hash_to_scalar(tag: bytes, preimage: bytes) -> int:
    for counter in range(2**32):
        digest = tagged_hash(tag, preimage + counter.to_bytes(4, "big"))
        value = int.from_bytes(digest, "big") % N
        if value != 0:
            return value
    raise RuntimeError("unreachable")


def encode_statement(
    network: str,
    transaction_binding: bytes,
    points: list[Point],
) -> bytes:
    return (
        bytes([VERSION, NETWORK_CODES[network]])
        + transaction_binding
        + b"".join(compress(point) for point in points)
    )


def derive_transaction_binding(network: str, transaction_id: bytes, output_index: int) -> bytes:
    if len(transaction_id) != 32:
        raise ValueError("transaction id must be 32 bytes")
    if transaction_id == bytes(32):
        raise ValueError("transaction id must be nonzero")
    return tagged_hash(
        TRANSACTION_BINDING_TAG,
        bytes([NETWORK_CODES[network]]) + transaction_id + output_index.to_bytes(4, "big"),
    )


def verify(statement: bytes, proof: bytes, h: Point) -> bool:
    """Verifier written only from the specification document."""
    try:
        if len(statement) != STATEMENT_LEN or len(proof) != PROOF_LEN:
            return False
        if statement[0] != VERSION or statement[1] not in NETWORK_CODES.values():
            return False
        if statement[2:34] == bytes(32):
            return False
        points = [
            decompress(statement[34 + 33 * index : 67 + 33 * index]) for index in range(7)
        ]
        pk_s, pk_r, x_s, x_r, y, c, h_stated = points
        if h_stated != h or y != c:
            return False
        a_s = decompress(proof[0:33])
        a_r = decompress(proof[33:66])
        b = decompress(proof[66:99])
        z_r = scalar_from_bytes(proof[99:131])
        z_v = scalar_from_bytes(proof[131:163])
    except ValueError:
        return False
    e = hash_to_scalar(CHALLENGE_TAG, statement + proof[0:99])
    if point_mul(z_r, pk_s) != point_add(a_s, point_mul(e, x_s)):
        return False
    if point_mul(z_r, pk_r) != point_add(a_r, point_mul(e, x_r)):
        return False
    lhs = point_add(point_mul(z_r, G), point_mul(z_v, h))
    rhs = point_add(b, point_mul(e, y))
    return lhs == rhs


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    fixture = json.loads((root / "fixtures" / "pgc-equal-vectors.json").read_text())

    check(2**256 - 1 < 2 * N, "single conditional subtraction reduces any 256-bit hash mod n")

    h, h_counter = derive_h()
    print(f"       H counter = {h_counter}, H = {compress(h).hex()}")
    check(compress(h).hex() == fixture["messageGenerator"], "fixture messageGenerator equals derived H")
    check(h != G, "H differs from G")

    for vector in fixture["vectors"]:
        name = vector["name"]
        sk_s = int(vector["senderSecret"])
        sk_r = int(vector["receiverSecret"])
        r = int(vector["randomness"])
        v = int(vector["value"])
        aux = bytes.fromhex(vector["auxiliaryRandomness"])
        transaction_binding = bytes.fromhex(vector["transactionBinding"])
        if "transactionId" in vector:
            check(
                transaction_binding
                == derive_transaction_binding(
                    vector["network"],
                    bytes.fromhex(vector["transactionId"]),
                    int(vector["outputIndex"]),
                ),
                f"{name}: transaction binding derives from network, transaction, output and policy domain",
            )

        pk_s = point_mul(sk_s, G)
        pk_r = point_mul(sk_r, G)
        x_s = point_mul(r, pk_s)
        x_r = point_mul(r, pk_r)
        y = point_add(point_mul(r, G), point_mul(v, h))
        statement = encode_statement(
            vector["network"], transaction_binding, [pk_s, pk_r, x_s, x_r, y, y, h]
        )
        check(statement.hex() == vector["statement"], f"{name}: statement bytes reproduce")

        witness = r.to_bytes(32, "big") + v.to_bytes(32, "big")
        a = hash_to_scalar(NONCE_TAG, bytes([0]) + witness + aux + statement)
        b = hash_to_scalar(NONCE_TAG, bytes([1]) + witness + aux + statement)
        a_s = point_mul(a, pk_s)
        a_r = point_mul(a, pk_r)
        b_point = point_add(point_mul(a, G), point_mul(b, h))
        commitments = compress(a_s) + compress(a_r) + compress(b_point)
        e = hash_to_scalar(CHALLENGE_TAG, statement + commitments)
        z_r = (a + e * r) % N
        z_v = (b + e * v) % N
        proof = commitments + z_r.to_bytes(32, "big") + z_v.to_bytes(32, "big")
        check(proof.hex() == vector["proof"], f"{name}: proof bytes reproduce")
        print(f"       challenge e = {e:064x}")

        fixture_statement = bytes.fromhex(vector["statement"])
        fixture_proof = bytes.fromhex(vector["proof"])
        check(verify(fixture_statement, fixture_proof, h), f"{name}: fixture verifies")

        # Receiver decryption: Y - sk_r^{-1} * X_r = v * H.
        recovered = point_add(y, point_mul(N - pow(sk_r, N - 2, N), x_r))
        check(recovered == point_mul(v, h), f"{name}: receiver recovers v*H from (X_r, Y)")

        # Negative controls.
        wrong_tx = bytearray(fixture_statement)
        wrong_tx[2] ^= 1
        check(not verify(bytes(wrong_tx), fixture_proof, h), f"{name}: rejects altered transaction binding")
        wrong_network = bytearray(fixture_statement)
        wrong_network[1] = NETWORK_CODES["bitcoin-signet"]
        check(not verify(bytes(wrong_network), fixture_proof, h), f"{name}: rejects altered network")
        wrong_zv = bytearray(fixture_proof)
        wrong_zv[-1] ^= 1
        check(not verify(fixture_statement, bytes(wrong_zv), h), f"{name}: rejects altered z_v")
        wrong_zr = bytearray(fixture_proof)
        wrong_zr[99 + 31] ^= 1
        check(not verify(fixture_statement, bytes(wrong_zr), h), f"{name}: rejects altered z_r")
        swapped = fixture_proof[33:66] + fixture_proof[0:33] + fixture_proof[66:]
        if pk_s == pk_r:
            check(swapped == fixture_proof, f"{name}: equal keys make A_s/A_r identical")
        else:
            check(not verify(fixture_statement, swapped, h), f"{name}: rejects swapped A_s/A_r")
        wrong_c = bytearray(fixture_statement)
        wrong_c[199:232] = compress(point_mul(23, G))
        check(not verify(bytes(wrong_c), fixture_proof, h), f"{name}: rejects C != Y")

        # A proof for a different value with the same public keys must not verify here.
        other_y = point_add(point_mul(r, G), point_mul(v + 1, h))
        other_statement = encode_statement(
            vector["network"], transaction_binding, [pk_s, pk_r, x_s, x_r, other_y, other_y, h]
        )
        check(not verify(other_statement, fixture_proof, h), f"{name}: rejects proof transplanted to v+1")

    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed:")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
