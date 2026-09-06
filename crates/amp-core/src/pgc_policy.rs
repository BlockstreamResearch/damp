//! Experimental PGC twisted-ElGamal equal-value policy.
//!
//! This module implements only the `L_equal` Sigma relation from section 5.2.1
//! of Chen et al., IACR ePrint 2019/319 revision 2025-09-06, adapted to
//! secp256k1 and bound to a caller-supplied transaction/template digest and
//! value commitment.
//! It is not a range proof, a solvency proof, a transaction signature, or a
//! complete confidential-payment system.

use std::{fmt, sync::OnceLock};

use anyhow::Context;
use secp256k1_zkp::{PublicKey, Scalar, Secp256k1, SecretKey, VerifyOnly};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

const VERSION: u8 = 1;
const POINT_LEN: usize = 33;
const SCALAR_LEN: usize = 32;
const STATEMENT_LEN: usize = 1 + 1 + 32 + 7 * POINT_LEN;
const PROOF_LEN: usize = 3 * POINT_LEN + 2 * SCALAR_LEN;
const CHALLENGE_TAG: &[u8] = b"simplicity-amp/pgc-equal/challenge/v1";
const H_GENERATOR_TAG: &[u8] = b"simplicity-amp/pgc-equal/h-generator/v1";
const NONCE_TAG: &[u8] = b"simplicity-amp/pgc-equal/nonce/v1";
const TRANSACTION_BINDING_TAG: &[u8] = b"simplicity-amp/pgc-equal/transaction-binding/v1";
const CURVE_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// Ledger network identifier included in the Fiat--Shamir transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PgcNetwork {
    BitcoinMainnet,
    BitcoinTestnet,
    BitcoinSignet,
    BitcoinRegtest,
    LiquidMainnet,
    LiquidTestnet,
    ElementsRegtest,
}

impl PgcNetwork {
    const fn code(self) -> u8 {
        match self {
            Self::BitcoinMainnet => 0,
            Self::BitcoinTestnet => 1,
            Self::BitcoinSignet => 2,
            Self::BitcoinRegtest => 3,
            Self::LiquidMainnet => 4,
            Self::LiquidTestnet => 5,
            Self::ElementsRegtest => 6,
        }
    }

    fn from_code(code: u8) -> anyhow::Result<Self> {
        match code {
            0 => Ok(Self::BitcoinMainnet),
            1 => Ok(Self::BitcoinTestnet),
            2 => Ok(Self::BitcoinSignet),
            3 => Ok(Self::BitcoinRegtest),
            4 => Ok(Self::LiquidMainnet),
            5 => Ok(Self::LiquidTestnet),
            6 => Ok(Self::ElementsRegtest),
            _ => anyhow::bail!("unsupported PGC network code {code}"),
        }
    }
}

/// Derive the host binding for one output of an already identified transaction.
///
/// `transaction_id` is the 32 bytes shown by block explorers, in display order.
/// The versioned tagged-hash domain identifies this PGC policy; the preimage
/// additionally commits to the network and big-endian output index. A host must
/// still confirm that the transaction is real and that the selected output has
/// the intended application-layer meaning before using the resulting proof.
pub fn derive_transaction_binding(
    network: PgcNetwork,
    transaction_id: [u8; 32],
    output_index: u32,
) -> anyhow::Result<[u8; 32]> {
    anyhow::ensure!(transaction_id != [0; 32], "transaction id must be nonzero");
    let mut preimage = [0_u8; 37];
    preimage[0] = network.code();
    preimage[1..33].copy_from_slice(&transaction_id);
    preimage[33..].copy_from_slice(&output_index.to_be_bytes());
    Ok(tagged_hash(TRANSACTION_BINDING_TAG, &preimage))
}

/// Canonical compressed non-infinity secp256k1 point.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct CanonicalPoint([u8; POINT_LEN]);

impl CanonicalPoint {
    /// Parse exactly one SEC1 compressed point (`02/03 || x`).
    pub fn from_bytes(bytes: [u8; POINT_LEN]) -> anyhow::Result<Self> {
        anyhow::ensure!(
            matches!(bytes[0], 0x02 | 0x03),
            "point is not compressed SEC1"
        );
        let point = PublicKey::from_slice(&bytes).context("invalid secp256k1 point")?;
        anyhow::ensure!(point.serialize() == bytes, "non-canonical secp256k1 point");
        Ok(Self(bytes))
    }

    #[must_use]
    pub const fn to_bytes(self) -> [u8; POINT_LEN] {
        self.0
    }

    fn from_public_key(point: PublicKey) -> Self {
        Self(point.serialize())
    }

    fn public_key(self) -> PublicKey {
        PublicKey::from_slice(&self.0).expect("CanonicalPoint invariant")
    }
}

impl fmt::Debug for CanonicalPoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&hex::encode(self.0))
    }
}

/// Canonical big-endian secp256k1 scalar in `[0, n)`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct CanonicalScalar([u8; SCALAR_LEN]);

impl CanonicalScalar {
    pub fn from_bytes(bytes: [u8; SCALAR_LEN]) -> anyhow::Result<Self> {
        Scalar::from_be_bytes(bytes)
            .map_err(|_| anyhow::anyhow!("scalar is not canonical (< n)"))?;
        Ok(Self(bytes))
    }

    pub fn from_u64(value: u64) -> Self {
        let mut bytes = [0; SCALAR_LEN];
        bytes[SCALAR_LEN - 8..].copy_from_slice(&value.to_be_bytes());
        Self(bytes)
    }

    #[must_use]
    pub const fn to_bytes(self) -> [u8; SCALAR_LEN] {
        self.0
    }

    #[must_use]
    pub fn is_zero(self) -> bool {
        self.0 == [0; SCALAR_LEN]
    }

    fn require_nonzero(self, name: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(!self.is_zero(), "{name} must be nonzero");
        Ok(self)
    }

    fn scalar(self) -> Scalar {
        Scalar::from_be_bytes(self.0).expect("CanonicalScalar invariant")
    }
}

impl fmt::Debug for CanonicalScalar {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalScalar([REDACTED])")
    }
}

impl Zeroize for CanonicalScalar {
    fn zeroize(&mut self) {
        self.0.zeroize();
    }
}

/// Public statement for the shared-randomness, equal-plaintext PGC relation.
///
/// With fixed generators `G` and `H`, the statement is in the language iff
/// there are scalars `(r, v)` such that `X_s = r*pk_s`, `X_r = r*pk_r`,
/// `Y = r*G + v*H`, and `value_commitment = Y`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EqualValueStatement {
    pub network: PgcNetwork,
    /// Host-defined digest that must commit to the transaction/template
    /// and to the location/meaning of `value_commitment`.
    pub transaction_binding: [u8; 32],
    pub sender_public_key: CanonicalPoint,
    pub receiver_public_key: CanonicalPoint,
    pub sender_handle: CanonicalPoint,
    pub receiver_handle: CanonicalPoint,
    pub ciphertext_body: CanonicalPoint,
    pub value_commitment: CanonicalPoint,
    /// Explicit `H` makes the parameter choice transcript-visible.
    pub message_generator: CanonicalPoint,
}

impl EqualValueStatement {
    pub const ENCODED_LEN: usize = STATEMENT_LEN;

    /// Construct a consistent statement from a witness. This helper does not
    /// prove that the host's `transaction_binding` came from a real transaction.
    pub fn from_witness(
        network: PgcNetwork,
        transaction_binding: [u8; 32],
        sender_public_key: CanonicalPoint,
        receiver_public_key: CanonicalPoint,
        witness: &EqualValueWitness,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            transaction_binding != [0; 32],
            "transaction binding must be nonzero"
        );
        witness
            .randomness
            .require_nonzero("encryption randomness")?;
        let g = generator_g();
        let h = generator_h();
        let sender_handle = scale_point(sender_public_key, witness.randomness)?
            .context("sender handle is point at infinity")?;
        let receiver_handle = scale_point(receiver_public_key, witness.randomness)?
            .context("receiver handle is point at infinity")?;
        let ciphertext_body = add_points(
            scale_point(g, witness.randomness)?,
            scale_point(h, witness.value)?,
        )?
        .context("ciphertext body is point at infinity")?;
        Ok(Self {
            network,
            transaction_binding,
            sender_public_key,
            receiver_public_key,
            sender_handle,
            receiver_handle,
            ciphertext_body,
            value_commitment: ciphertext_body,
            message_generator: h,
        })
    }

    #[must_use]
    pub fn encode(self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(Self::ENCODED_LEN);
        encoded.push(VERSION);
        encoded.push(self.network.code());
        encoded.extend_from_slice(&self.transaction_binding);
        for point in [
            self.sender_public_key,
            self.receiver_public_key,
            self.sender_handle,
            self.receiver_handle,
            self.ciphertext_body,
            self.value_commitment,
            self.message_generator,
        ] {
            encoded.extend_from_slice(&point.to_bytes());
        }
        encoded
    }

    pub fn decode(encoded: &[u8]) -> anyhow::Result<Self> {
        anyhow::ensure!(
            encoded.len() == Self::ENCODED_LEN,
            "PGC statement must be exactly {} bytes",
            Self::ENCODED_LEN
        );
        anyhow::ensure!(
            encoded[0] == VERSION,
            "unsupported PGC statement version {}",
            encoded[0]
        );
        let network = PgcNetwork::from_code(encoded[1])?;
        let mut transaction_binding = [0; 32];
        transaction_binding.copy_from_slice(&encoded[2..34]);
        let mut offset = 34;
        let mut next_point = || -> anyhow::Result<CanonicalPoint> {
            let mut bytes = [0; POINT_LEN];
            bytes.copy_from_slice(&encoded[offset..offset + POINT_LEN]);
            offset += POINT_LEN;
            CanonicalPoint::from_bytes(bytes)
        };
        let statement = Self {
            network,
            transaction_binding,
            sender_public_key: next_point()?,
            receiver_public_key: next_point()?,
            sender_handle: next_point()?,
            receiver_handle: next_point()?,
            ciphertext_body: next_point()?,
            value_commitment: next_point()?,
            message_generator: next_point()?,
        };
        anyhow::ensure!(
            statement.message_generator == generator_h(),
            "unexpected PGC message generator"
        );
        anyhow::ensure!(
            statement.transaction_binding != [0; 32],
            "transaction binding must be nonzero"
        );
        anyhow::ensure!(
            statement.ciphertext_body == statement.value_commitment,
            "ciphertext body does not match the host value commitment"
        );
        Ok(statement)
    }

    /// Verify the Fiat--Shamir transformed PGC `Sigma_equal` proof.
    pub fn verify(self, proof: EqualValueProof) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.transaction_binding != [0; 32],
            "transaction binding must be nonzero"
        );
        anyhow::ensure!(
            self.message_generator == generator_h(),
            "unexpected PGC message generator"
        );
        anyhow::ensure!(
            self.ciphertext_body == self.value_commitment,
            "ciphertext body does not match the host value commitment"
        );
        let challenge = challenge(
            self,
            proof.sender_commitment,
            proof.receiver_commitment,
            proof.body_commitment,
        )?;

        equation(
            scale_point(self.sender_public_key, proof.randomness_response)?,
            add_points(
                Some(proof.sender_commitment),
                scale_point(self.sender_handle, challenge)?,
            )?,
            "sender encryption handle",
        )?;
        equation(
            scale_point(self.receiver_public_key, proof.randomness_response)?,
            add_points(
                Some(proof.receiver_commitment),
                scale_point(self.receiver_handle, challenge)?,
            )?,
            "receiver encryption handle",
        )?;
        let left = add_points(
            scale_point(generator_g(), proof.randomness_response)?,
            scale_point(self.message_generator, proof.value_response)?,
        )?;
        let right = add_points(
            Some(proof.body_commitment),
            scale_point(self.ciphertext_body, challenge)?,
        )?;
        equation(left, right, "ciphertext body")
    }
}

/// Secret witness `(r, v)`. `v` is a field element, not a range-checked amount.
#[derive(Debug, PartialEq, Eq)]
pub struct EqualValueWitness {
    pub randomness: CanonicalScalar,
    pub value: CanonicalScalar,
}

impl Drop for EqualValueWitness {
    fn drop(&mut self) {
        self.randomness.zeroize();
        self.value.zeroize();
    }
}

/// Non-interactive PGC `Sigma_equal` proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EqualValueProof {
    pub sender_commitment: CanonicalPoint,
    pub receiver_commitment: CanonicalPoint,
    pub body_commitment: CanonicalPoint,
    pub randomness_response: CanonicalScalar,
    pub value_response: CanonicalScalar,
}

impl EqualValueProof {
    pub const ENCODED_LEN: usize = PROOF_LEN;

    /// Create a proof with hedged deterministic nonces derived from the witness,
    /// complete statement, role byte, and caller-provided auxiliary randomness.
    /// Production callers should fill `auxiliary_randomness` from a CSPRNG.
    pub fn prove(
        statement: EqualValueStatement,
        witness: &EqualValueWitness,
        auxiliary_randomness: [u8; 32],
    ) -> anyhow::Result<Self> {
        witness
            .randomness
            .require_nonzero("encryption randomness")?;
        anyhow::ensure!(
            statement.message_generator == generator_h(),
            "unexpected PGC message generator"
        );
        let expected = EqualValueStatement::from_witness(
            statement.network,
            statement.transaction_binding,
            statement.sender_public_key,
            statement.receiver_public_key,
            witness,
        )?;
        anyhow::ensure!(
            expected == statement,
            "witness does not open the PGC statement"
        );
        let auxiliary_randomness = Zeroizing::new(auxiliary_randomness);
        let randomness_nonce =
            Zeroizing::new(derive_nonce(0, statement, witness, &auxiliary_randomness));
        let value_nonce =
            Zeroizing::new(derive_nonce(1, statement, witness, &auxiliary_randomness));

        let sender_commitment = scale_point(statement.sender_public_key, *randomness_nonce)?
            .context("sender proof commitment is point at infinity")?;
        let receiver_commitment = scale_point(statement.receiver_public_key, *randomness_nonce)?
            .context("receiver proof commitment is point at infinity")?;
        let body_commitment = add_points(
            scale_point(generator_g(), *randomness_nonce)?,
            scale_point(statement.message_generator, *value_nonce)?,
        )?
        .context("body proof commitment is point at infinity")?;
        let challenge = challenge(
            statement,
            sender_commitment,
            receiver_commitment,
            body_commitment,
        )?;
        let proof = Self {
            sender_commitment,
            receiver_commitment,
            body_commitment,
            randomness_response: add_mul(*randomness_nonce, challenge, witness.randomness)?,
            value_response: add_mul(*value_nonce, challenge, witness.value)?,
        };
        statement.verify(proof)?;
        Ok(proof)
    }

    #[must_use]
    pub fn encode(self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(Self::ENCODED_LEN);
        for point in [
            self.sender_commitment,
            self.receiver_commitment,
            self.body_commitment,
        ] {
            encoded.extend_from_slice(&point.to_bytes());
        }
        encoded.extend_from_slice(&self.randomness_response.to_bytes());
        encoded.extend_from_slice(&self.value_response.to_bytes());
        encoded
    }

    pub fn decode(encoded: &[u8]) -> anyhow::Result<Self> {
        anyhow::ensure!(
            encoded.len() == Self::ENCODED_LEN,
            "PGC proof must be exactly {} bytes",
            Self::ENCODED_LEN
        );
        let point = |offset: usize| -> anyhow::Result<CanonicalPoint> {
            let mut bytes = [0; POINT_LEN];
            bytes.copy_from_slice(&encoded[offset..offset + POINT_LEN]);
            CanonicalPoint::from_bytes(bytes)
        };
        let scalar = |offset: usize| -> anyhow::Result<CanonicalScalar> {
            let mut bytes = [0; SCALAR_LEN];
            bytes.copy_from_slice(&encoded[offset..offset + SCALAR_LEN]);
            CanonicalScalar::from_bytes(bytes)
        };
        Ok(Self {
            sender_commitment: point(0)?,
            receiver_commitment: point(POINT_LEN)?,
            body_commitment: point(2 * POINT_LEN)?,
            randomness_response: scalar(3 * POINT_LEN)?,
            value_response: scalar(3 * POINT_LEN + SCALAR_LEN)?,
        })
    }
}

fn generator_g() -> CanonicalPoint {
    static GENERATOR: OnceLock<CanonicalPoint> = OnceLock::new();
    *GENERATOR.get_or_init(|| {
        let mut one = [0; 32];
        one[31] = 1;
        let secret = SecretKey::from_slice(&one).expect("one is a secret key");
        CanonicalPoint::from_public_key(PublicKey::from_secret_key(&Secp256k1::new(), &secret))
    })
}

fn generator_h() -> CanonicalPoint {
    static GENERATOR: OnceLock<CanonicalPoint> = OnceLock::new();
    *GENERATOR.get_or_init(derive_generator_h)
}

fn derive_generator_h() -> CanonicalPoint {
    for counter in 0_u32..=u32::MAX {
        let digest = tagged_hash(H_GENERATOR_TAG, &counter.to_be_bytes());
        let mut candidate = [0; POINT_LEN];
        candidate[0] = 0x02;
        candidate[1..].copy_from_slice(&digest);
        if let Ok(point) = CanonicalPoint::from_bytes(candidate) {
            assert_ne!(point, generator_g(), "derived H equals G");
            return point;
        }
    }
    unreachable!("a secp256k1 point exists for a hash-to-point counter")
}

fn derive_nonce(
    role: u8,
    statement: EqualValueStatement,
    witness: &EqualValueWitness,
    auxiliary_randomness: &[u8; 32],
) -> CanonicalScalar {
    let mut preimage = Zeroizing::new(Vec::with_capacity(1 + 32 + 32 + 32 + STATEMENT_LEN + 4));
    preimage.push(role);
    preimage.extend_from_slice(&witness.randomness.to_bytes());
    preimage.extend_from_slice(&witness.value.to_bytes());
    preimage.extend_from_slice(auxiliary_randomness);
    preimage.extend_from_slice(&statement.encode());
    for counter in 0_u32..=u32::MAX {
        preimage.extend_from_slice(&counter.to_be_bytes());
        let nonce = reduce_scalar(tagged_hash(NONCE_TAG, &preimage));
        let preimage_len = preimage.len() - 4;
        preimage.truncate(preimage_len);
        if !nonce.is_zero() {
            return nonce;
        }
    }
    unreachable!("nonzero proof nonce exists")
}

fn challenge(
    statement: EqualValueStatement,
    sender_commitment: CanonicalPoint,
    receiver_commitment: CanonicalPoint,
    body_commitment: CanonicalPoint,
) -> anyhow::Result<CanonicalScalar> {
    let mut transcript = statement.encode();
    transcript.extend_from_slice(&sender_commitment.to_bytes());
    transcript.extend_from_slice(&receiver_commitment.to_bytes());
    transcript.extend_from_slice(&body_commitment.to_bytes());
    for counter in 0_u32..=u32::MAX {
        let mut input = transcript.clone();
        input.extend_from_slice(&counter.to_be_bytes());
        let reduced = reduce_scalar(tagged_hash(CHALLENGE_TAG, &input));
        if !reduced.is_zero() {
            return Ok(reduced);
        }
    }
    unreachable!("nonzero challenge exists")
}

fn tagged_hash(tag: &[u8], message: &[u8]) -> [u8; 32] {
    let tag_hash = Sha256::digest(tag);
    let mut hasher = Sha256::new();
    hasher.update(tag_hash);
    hasher.update(tag_hash);
    hasher.update(message);
    hasher.finalize().into()
}

fn reduce_scalar(bytes: [u8; 32]) -> CanonicalScalar {
    if bytes < CURVE_ORDER {
        return CanonicalScalar(bytes);
    }

    // A 256-bit integer is less than 2*n for the secp256k1 order, so one
    // subtraction is the complete reduction.
    let mut reduced = [0; SCALAR_LEN];
    let mut borrow = 0_i16;
    for index in (0..SCALAR_LEN).rev() {
        let difference = i16::from(bytes[index]) - i16::from(CURVE_ORDER[index]) - borrow;
        if difference < 0 {
            reduced[index] = (difference + 256) as u8;
            borrow = 1;
        } else {
            reduced[index] = difference as u8;
            borrow = 0;
        }
    }
    debug_assert_eq!(borrow, 0);
    CanonicalScalar(reduced)
}

fn add_mul(
    a: CanonicalScalar,
    b: CanonicalScalar,
    c: CanonicalScalar,
) -> anyhow::Result<CanonicalScalar> {
    let product = if b.is_zero() || c.is_zero() {
        CanonicalScalar::from_u64(0)
    } else {
        let secret = SecretKey::from_slice(&c.0).context("canonical nonzero scalar")?;
        let product = secret
            .mul_tweak(&b.scalar())
            .context("nonzero scalar multiplication")?;
        CanonicalScalar(product.secret_bytes())
    };

    if product.is_zero() {
        return Ok(a);
    }
    if a.is_zero() {
        return Ok(product);
    }
    let secret = SecretKey::from_slice(&product.0).context("canonical nonzero product")?;
    match secret.add_tweak(&a.scalar()) {
        Ok(sum) => Ok(CanonicalScalar(sum.secret_bytes())),
        // Both operands are canonical and nonzero, so the only invalid result
        // is their sum being zero modulo n.
        Err(secp256k1_zkp::UpstreamError::InvalidTweak) => Ok(CanonicalScalar::from_u64(0)),
        Err(error) => Err(error).context("scalar response addition"),
    }
}

type MaybePoint = Option<CanonicalPoint>;

fn scale_point(point: CanonicalPoint, scalar: CanonicalScalar) -> anyhow::Result<MaybePoint> {
    if scalar.is_zero() {
        return Ok(None);
    }
    let scaled = point
        .public_key()
        .mul_tweak(verification_context(), &scalar.scalar())
        .context("invalid secp256k1 point multiplication")?;
    Ok(Some(CanonicalPoint::from_public_key(scaled)))
}

fn verification_context() -> &'static Secp256k1<VerifyOnly> {
    static CONTEXT: OnceLock<Secp256k1<VerifyOnly>> = OnceLock::new();
    CONTEXT.get_or_init(Secp256k1::verification_only)
}

fn add_points(left: MaybePoint, right: MaybePoint) -> anyhow::Result<MaybePoint> {
    match (left, right) {
        (None, value) | (value, None) => Ok(value),
        (Some(left), Some(right)) => match left.public_key().combine(&right.public_key()) {
            Ok(sum) => Ok(Some(CanonicalPoint::from_public_key(sum))),
            Err(secp256k1_zkp::UpstreamError::InvalidPublicKeySum) => Ok(None),
            Err(error) => Err(error).context("invalid secp256k1 point addition"),
        },
    }
}

fn equation(left: MaybePoint, right: MaybePoint, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(left == right, "invalid PGC proof equation for {name}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scalar(value: u64) -> CanonicalScalar {
        CanonicalScalar::from_u64(value)
    }

    fn scalar_from_decimal(value: &str) -> CanonicalScalar {
        let mut bytes = [0_u8; SCALAR_LEN];
        for digit in value.bytes() {
            assert!(digit.is_ascii_digit(), "fixture scalar must be decimal");
            let mut carry = u16::from(digit - b'0');
            for byte in bytes.iter_mut().rev() {
                let next = u16::from(*byte) * 10 + carry;
                *byte = next as u8;
                carry = next >> 8;
            }
            assert_eq!(carry, 0, "fixture scalar exceeds 256 bits");
        }
        CanonicalScalar::from_bytes(bytes).expect("fixture scalar is canonical")
    }

    fn bytes32_from_hex(value: &str) -> [u8; 32] {
        hex::decode(value)
            .expect("fixture hex")
            .try_into()
            .expect("fixture field is 32 bytes")
    }

    fn network_from_name(value: &str) -> PgcNetwork {
        match value {
            "bitcoin-mainnet" => PgcNetwork::BitcoinMainnet,
            "bitcoin-testnet" => PgcNetwork::BitcoinTestnet,
            "bitcoin-signet" => PgcNetwork::BitcoinSignet,
            "bitcoin-regtest" | "regtest" => PgcNetwork::BitcoinRegtest,
            "liquid-mainnet" => PgcNetwork::LiquidMainnet,
            "liquid-testnet" => PgcNetwork::LiquidTestnet,
            "elements-regtest" => PgcNetwork::ElementsRegtest,
            _ => panic!("unknown fixture network {value}"),
        }
    }

    fn public_key(secret: u64) -> CanonicalPoint {
        public_key_from_scalar(scalar(secret))
    }

    fn public_key_from_scalar(secret: CanonicalScalar) -> CanonicalPoint {
        scale_point(generator_g(), secret).unwrap().unwrap()
    }

    fn vector() -> (EqualValueStatement, EqualValueProof) {
        let witness = EqualValueWitness {
            randomness: scalar(7),
            value: scalar(42_000),
        };
        let statement = EqualValueStatement::from_witness(
            PgcNetwork::BitcoinRegtest,
            [0x5a; 32],
            public_key(11),
            public_key(13),
            &witness,
        )
        .unwrap();
        let proof = EqualValueProof::prove(statement, &witness, [0x11; 32]).unwrap();
        (statement, proof)
    }

    #[test]
    fn valid_equal_value_proof_round_trips() {
        let (statement, proof) = vector();
        statement.verify(proof).unwrap();
        assert_eq!(
            EqualValueStatement::decode(&statement.encode()).unwrap(),
            statement
        );
        assert_eq!(EqualValueProof::decode(&proof.encode()).unwrap(), proof);
    }

    #[test]
    fn hedged_nonces_bind_statement_and_auxiliary_randomness() {
        let witness = EqualValueWitness {
            randomness: scalar(7),
            value: scalar(42_000),
        };
        let (statement, proof) = vector();
        assert_eq!(
            EqualValueProof::prove(statement, &witness, [0x11; 32]).unwrap(),
            proof
        );
        assert_ne!(
            EqualValueProof::prove(statement, &witness, [0x12; 32]).unwrap(),
            proof
        );
        let other_statement = EqualValueStatement::from_witness(
            PgcNetwork::BitcoinRegtest,
            [0x5b; 32],
            public_key(11),
            public_key(13),
            &witness,
        )
        .unwrap();
        assert_ne!(
            EqualValueProof::prove(other_statement, &witness, [0x11; 32]).unwrap(),
            proof
        );
    }

    #[test]
    fn transcript_binds_network_and_transaction() {
        let (statement, proof) = vector();
        let mut wrong_tx = statement;
        wrong_tx.transaction_binding[0] ^= 1;
        assert!(wrong_tx.verify(proof).is_err());
        let mut wrong_network = statement;
        wrong_network.network = PgcNetwork::BitcoinSignet;
        assert!(wrong_network.verify(proof).is_err());
        let mut missing_binding = statement;
        missing_binding.transaction_binding = [0; 32];
        assert!(missing_binding.verify(proof).is_err());
    }

    #[test]
    fn rejects_commitment_or_ciphertext_mismatch() {
        let (statement, proof) = vector();
        let mut wrong_commitment = statement;
        wrong_commitment.value_commitment = public_key(23);
        assert!(wrong_commitment.verify(proof).is_err());
        let mut wrong_handle = statement;
        wrong_handle.receiver_handle = public_key(29);
        assert!(wrong_handle.verify(proof).is_err());
        let mut wrong_generator = statement;
        wrong_generator.message_generator = public_key(31);
        assert!(wrong_generator.verify(proof).is_err());
        assert!(EqualValueStatement::decode(&wrong_generator.encode()).is_err());
    }

    #[test]
    fn rejects_mutated_proof_fields_and_zero_responses() {
        let (statement, mut proof) = vector();
        proof.value_response = scalar(1);
        assert!(statement.verify(proof).is_err());
        let (_, proof) = vector();
        for field in 0..3 {
            let mut mutated = proof;
            match field {
                0 => mutated.sender_commitment = public_key(37),
                1 => mutated.receiver_commitment = public_key(41),
                _ => mutated.body_commitment = public_key(43),
            }
            assert!(statement.verify(mutated).is_err());
        }
        let mut zero_randomness_response = proof;
        zero_randomness_response.randomness_response = scalar(0);
        assert!(statement.verify(zero_randomness_response).is_err());
        let mut zero_value_response = proof;
        zero_value_response.value_response = scalar(0);
        assert!(statement.verify(zero_value_response).is_err());
    }

    #[test]
    fn rejects_malformed_encodings() {
        let (statement, proof) = vector();
        assert!(EqualValueStatement::decode(&statement.encode()[..STATEMENT_LEN - 1]).is_err());
        let mut uncompressed = statement.encode();
        uncompressed[34] = 0x04;
        assert!(EqualValueStatement::decode(&uncompressed).is_err());
        let mut invalid_point = statement.encode();
        invalid_point[34] = 0x02;
        invalid_point[35..67].fill(0xff);
        assert!(EqualValueStatement::decode(&invalid_point).is_err());
        let mut unknown_version = statement.encode();
        unknown_version[0] = 2;
        assert!(EqualValueStatement::decode(&unknown_version).is_err());
        let mut unknown_network = statement.encode();
        unknown_network[1] = 7;
        assert!(EqualValueStatement::decode(&unknown_network).is_err());
        let mut trailing = proof.encode();
        trailing.push(0);
        assert!(EqualValueProof::decode(&trailing).is_err());
        let mut noncanonical_scalar = proof.encode();
        noncanonical_scalar[3 * POINT_LEN..3 * POINT_LEN + SCALAR_LEN]
            .copy_from_slice(&CURVE_ORDER);
        assert!(EqualValueProof::decode(&noncanonical_scalar).is_err());
    }

    #[test]
    fn rejects_zero_encryption_randomness() {
        let witness = EqualValueWitness {
            randomness: scalar(0),
            value: scalar(5),
        };
        assert!(
            EqualValueStatement::from_witness(
                PgcNetwork::BitcoinRegtest,
                [1; 32],
                public_key(2),
                public_key(3),
                &witness,
            )
            .is_err()
        );
    }

    #[test]
    fn decode_rejects_commitment_mismatch() {
        let (statement, _) = vector();
        let mut encoded = statement.encode();
        encoded[199..232].copy_from_slice(&public_key(23).to_bytes());
        assert!(EqualValueStatement::decode(&encoded).is_err());
    }

    #[test]
    fn liquid_binding_commits_to_network_transaction_and_output() {
        let txid = [0x39; 32];
        let binding = derive_transaction_binding(PgcNetwork::LiquidTestnet, txid, 2).unwrap();
        assert_ne!(binding, [0; 32]);
        assert_ne!(
            binding,
            derive_transaction_binding(PgcNetwork::LiquidMainnet, txid, 2).unwrap()
        );
        let mut other_txid = txid;
        other_txid[31] ^= 1;
        assert_ne!(
            binding,
            derive_transaction_binding(PgcNetwork::LiquidTestnet, other_txid, 2).unwrap()
        );
        assert_ne!(
            binding,
            derive_transaction_binding(PgcNetwork::LiquidTestnet, txid, 3).unwrap()
        );
        assert!(derive_transaction_binding(PgcNetwork::LiquidTestnet, [0; 32], 2).is_err());
    }

    #[test]
    fn accepted_edge_cases_round_trip() {
        for (network, sender, receiver, randomness, value) in [
            (
                PgcNetwork::LiquidTestnet,
                public_key(11),
                public_key(13),
                scalar(7),
                scalar(0),
            ),
            (
                PgcNetwork::ElementsRegtest,
                public_key(17),
                public_key(17),
                scalar(19),
                scalar(23),
            ),
            (
                PgcNetwork::BitcoinMainnet,
                public_key(29),
                public_key(31),
                scalar_from_decimal(
                    "14313749767032793406513346683016391891220544285159214036570551675209939353856",
                ),
                scalar_from_decimal(
                    "57896044618658097711785492504343953926634992332820282019728792003956564819967",
                ),
            ),
        ] {
            let witness = EqualValueWitness { randomness, value };
            let statement =
                EqualValueStatement::from_witness(network, [0x42; 32], sender, receiver, &witness)
                    .unwrap();
            let proof = EqualValueProof::prove(statement, &witness, [0x24; 32]).unwrap();
            statement.verify(proof).unwrap();
        }
    }

    #[test]
    fn fixed_generators_are_distinct_and_stable() {
        assert_ne!(generator_g(), generator_h());
        assert_eq!(
            hex::encode(generator_h().to_bytes()),
            "02ed9d2dd95c5e81889c23622b7c77b92a47c7d371f544d83645eee7e7b630d0bd"
        );
    }

    #[test]
    fn scalar_response_matches_group_arithmetic() {
        let base = public_key(11);
        let a = scalar(17);
        let b = CanonicalScalar::from_bytes([
            0x62, 0x45, 0x30, 0x8f, 0x1a, 0xbb, 0xb0, 0x7f, 0x91, 0x88, 0x77, 0x6f, 0x3b, 0xa0,
            0xa8, 0x8a, 0x90, 0xa6, 0xe8, 0x0d, 0xc2, 0x19, 0x21, 0x6e, 0x4f, 0xca, 0x35, 0x67,
            0x3d, 0x74, 0x13, 0xa1,
        ])
        .unwrap();
        let c = scalar(7);
        assert_eq!(
            scale_point(base, add_mul(a, b, c).unwrap()).unwrap(),
            add_points(
                scale_point(base, a).unwrap(),
                scale_point(scale_point(base, c).unwrap().unwrap(), b).unwrap(),
            )
            .unwrap()
        );
        let maximum = CanonicalScalar::from_bytes(Scalar::MAX.to_be_bytes()).unwrap();
        assert!(add_mul(maximum, scalar(1), scalar(1)).unwrap().is_zero());
        assert_eq!(add_mul(scalar(9), scalar(0), scalar(5)).unwrap(), scalar(9));
    }

    #[test]
    fn hash_scalar_reduction_covers_order_boundary() {
        assert!(reduce_scalar(CURVE_ORDER).is_zero());
        assert_eq!(
            reduce_scalar(Scalar::MAX.to_be_bytes()),
            CanonicalScalar::from_bytes(Scalar::MAX.to_be_bytes()).unwrap()
        );
        assert_eq!(reduce_scalar([0xff; 32]).scalar(), {
            let mut excess = [0xff; 32];
            let mut borrow = 0_i16;
            for index in (0..SCALAR_LEN).rev() {
                let difference = i16::from(excess[index]) - i16::from(CURVE_ORDER[index]) - borrow;
                excess[index] = if difference < 0 {
                    borrow = 1;
                    (difference + 256) as u8
                } else {
                    borrow = 0;
                    difference as u8
                };
            }
            Scalar::from_be_bytes(excess).unwrap()
        });
    }

    #[test]
    fn deterministic_vector_matches_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/pgc-equal-vectors.json")).unwrap();
        for vector in fixture["vectors"].as_array().expect("fixture vectors") {
            let network = network_from_name(vector["network"].as_str().expect("fixture network"));
            let transaction_binding = bytes32_from_hex(
                vector["transactionBinding"]
                    .as_str()
                    .expect("fixture transaction binding"),
            );
            if let Some(transaction_id) = vector["transactionId"].as_str() {
                assert_eq!(
                    transaction_binding,
                    derive_transaction_binding(
                        network,
                        bytes32_from_hex(transaction_id),
                        vector["outputIndex"]
                            .as_u64()
                            .expect("fixture output index") as u32,
                    )
                    .unwrap(),
                    "{} transaction binding",
                    vector["name"].as_str().unwrap()
                );
            }
            let witness = EqualValueWitness {
                randomness: scalar_from_decimal(
                    vector["randomness"].as_str().expect("fixture randomness"),
                ),
                value: scalar_from_decimal(vector["value"].as_str().expect("fixture value")),
            };
            let statement = EqualValueStatement::from_witness(
                network,
                transaction_binding,
                public_key_from_scalar(scalar_from_decimal(
                    vector["senderSecret"]
                        .as_str()
                        .expect("fixture sender secret"),
                )),
                public_key_from_scalar(scalar_from_decimal(
                    vector["receiverSecret"]
                        .as_str()
                        .expect("fixture receiver secret"),
                )),
                &witness,
            )
            .unwrap();
            let proof = EqualValueProof::prove(
                statement,
                &witness,
                bytes32_from_hex(
                    vector["auxiliaryRandomness"]
                        .as_str()
                        .expect("fixture auxiliary randomness"),
                ),
            )
            .unwrap();
            assert_eq!(
                vector["statement"],
                hex::encode(statement.encode()),
                "{} statement",
                vector["name"].as_str().unwrap()
            );
            assert_eq!(
                vector["proof"],
                hex::encode(proof.encode()),
                "{} proof",
                vector["name"].as_str().unwrap()
            );
        }
    }
}
