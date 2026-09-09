use num_bigint::BigUint;
use secp256k1_zkp::{Generator, PedersenCommitment, PublicKey, Scalar, Secp256k1, Tag};

use super::{AuditError, ProofEncodingError};

const FIELD: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xfc, 0x2f,
];

/// Canonical public field bytes. No secret scalar is converted to a big integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FieldElement([u8; 32]);

impl FieldElement {
    pub(super) fn parse(bytes: [u8; 32]) -> Result<Self, ProofEncodingError> {
        if bytes >= FIELD {
            return Err(ProofEncodingError::Root);
        }
        Ok(Self(bytes))
    }
    pub(super) const fn bytes(self) -> [u8; 32] {
        self.0
    }
    pub(super) fn squares_to(self, expected: [u8; 32]) -> bool {
        let root = BigUint::from_bytes_be(&self.0);
        &root * &root % public_field() == BigUint::from_bytes_be(&expected)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct NativePoint {
    pub(super) key: PublicKey,
    pub(super) root: FieldElement,
    pub(super) root_square: [u8; 32],
}

fn public_field() -> BigUint {
    BigUint::from_bytes_be(&FIELD)
}

fn bytes32(value: &BigUint) -> [u8; 32] {
    let bytes = value.to_bytes_be();
    let mut result = [0; 32];
    result[32 - bytes.len()..].copy_from_slice(&bytes);
    result
}

// Native commitments and generators encode the quadratic character of y,
// not SEC1 parity. The returned root binds the SEC1 point to that native bit.
fn decode_native(bytes: [u8; 33], base: u8) -> Result<NativePoint, AuditError> {
    if bytes[0] != base && bytes[0] != base + 1 {
        return Err(AuditError::NativePrefix);
    }
    let field = public_field();
    let x = BigUint::from_bytes_be(&bytes[1..]);
    if x >= field {
        return Err(AuditError::NativeCoordinate);
    }
    let rhs = ((&x * &x % &field) * &x + BigUint::from(7u8)) % &field;
    let mut y = rhs.modpow(&((&field + BigUint::from(1u8)) >> 2), &field);
    if &y * &y % &field != rhs {
        return Err(AuditError::NativePoint);
    }
    let is_square = y.modpow(&((&field - BigUint::from(1u8)) >> 1), &field) == BigUint::from(1u8);
    if is_square != (bytes[0] == base) {
        y = &field - &y;
    }
    let mut sec1 = [0; 33];
    sec1[0] = 2 + u8::from(y.bit(0));
    sec1[1..].copy_from_slice(&bytes[1..]);
    let target = if bytes[0] == base { y } else { &field - y };
    let root = target.modpow(&((&field + BigUint::from(1u8)) >> 2), &field);
    Ok(NativePoint {
        key: PublicKey::from_slice(&sec1)?,
        root: FieldElement::parse(bytes32(&root))?,
        root_square: bytes32(&target),
    })
}

pub(super) fn commitment_point(commitment: PedersenCommitment) -> Result<NativePoint, AuditError> {
    decode_native(commitment.serialize(), 8)
}

pub(super) fn generator(consensus_asset: [u8; 32]) -> Result<PublicKey, AuditError> {
    let generator = Generator::new_unblinded(&Secp256k1::new(), Tag::from(consensus_asset));
    Ok(decode_native(generator.serialize(), 10)?.key)
}

pub(super) fn scale(point: PublicKey, scalar: Scalar) -> Result<Option<PublicKey>, AuditError> {
    if scalar == Scalar::ZERO {
        return Ok(None);
    }
    Ok(Some(
        point.mul_tweak(&Secp256k1::verification_only(), &scalar)?,
    ))
}

pub(super) fn add(
    left: Option<PublicKey>,
    right: Option<PublicKey>,
) -> Result<Option<PublicKey>, AuditError> {
    match (left, right) {
        (None, right) => Ok(right),
        (left, None) => Ok(left),
        (Some(left), Some(right)) => match left.combine(&right) {
            Ok(point) => Ok(Some(point)),
            Err(secp256k1_zkp::UpstreamError::InvalidPublicKeySum) => Ok(None),
            Err(error) => Err(error.into()),
        },
    }
}
