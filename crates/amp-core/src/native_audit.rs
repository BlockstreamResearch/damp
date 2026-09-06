//! Native Elements commitment audit relation for autonomous generation-2 transfers.
//!
//! Scalar/group operations involving secrets use libsecp256k1. Big integers are
//! used only to reconstruct PUBLIC native QR encodings and their square roots.
use aes_gcm_siv::{
    Aes256GcmSiv, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::Context;
use num_bigint::BigUint;
use rand::{CryptoRng, RngCore};
use secp256k1_zkp::{
    Generator, PedersenCommitment, PublicKey, Scalar, Secp256k1, SecretKey, Tag, Tweak,
    ecdh::SharedSecret,
};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_AUDIT_VALUE: u64 = i64::MAX as u64;
pub const MAX_NATIVE_AUDIT_VALUE: u64 = 1u64 << 63;
pub const AUXILIARY_BYTES: usize = 102;
const ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
const TAG: &[u8] = b"DAMP/audit/autonomous/v3";

/// Only public statement fields. The transaction digest must be computed after
/// all outputs, range proofs and the auxiliary manifest commitment are fixed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditStatement {
    pub deployment: [u8; 32],
    pub epoch: u64,
    pub audit_key: PublicKey,
    pub sig_all_hash: [u8; 32],
    pub output_index: u32,
    pub asset: [u8; 32],
    pub commitment: PedersenCommitment,
    pub script_hash: [u8; 32],
    pub auxiliary: [u8; AUXILIARY_BYTES],
}

/// An opening never formats or serializes itself and clears its owned buffer.
pub struct AuditOpening {
    value: u64,
    blinder: Zeroizing<[u8; 32]>,
}
impl Drop for AuditOpening {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}
impl AuditOpening {
    pub fn new(value: u64, blinder: [u8; 32]) -> anyhow::Result<Self> {
        let blinder = Zeroizing::new(blinder);
        anyhow::ensure!(
            value <= MAX_AUDIT_VALUE,
            "audit amount exceeds application maximum"
        );
        Self::from_recovered(value, *blinder)
    }
    fn from_recovered(value: u64, blinder: [u8; 32]) -> anyhow::Result<Self> {
        let blinder = Zeroizing::new(blinder);
        anyhow::ensure!(
            (1..=MAX_NATIVE_AUDIT_VALUE).contains(&value),
            "audit amount outside native interval"
        );
        let _validated = ErasedSecret(
            SecretKey::from_slice(blinder.as_ref())
                .context("audit blinder must be canonical and nonzero")?,
        );
        Ok(Self { value, blinder })
    }
    pub fn value(&self) -> u64 {
        self.value
    }
    pub fn commitment(&self, asset: [u8; 32]) -> anyhow::Result<PedersenCommitment> {
        Ok(PedersenCommitment::new(
            &Secp256k1::new(),
            self.value,
            Tweak::from_slice(self.blinder.as_ref())?,
            Generator::new_unblinded(&Secp256k1::new(), Tag::from(asset)),
        ))
    }
    pub fn handle(&self, key: PublicKey) -> anyhow::Result<PublicKey> {
        Ok(key.mul_tweak(
            &Secp256k1::verification_only(),
            &Scalar::from_be_bytes(*self.blinder)?,
        )?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAuditProof {
    pub commitment_parity: bool,
    pub commitment_root: [u8; 32],
    pub handle: PublicKey,
    pub commitment_nonce: PublicKey,
    pub handle_nonce: PublicKey,
    pub value_response: [u8; 32],
    pub blinder_response: [u8; 32],
}

fn tagged_hash(tag: &[u8], bytes: &[u8]) -> [u8; 32] {
    let tag = Sha256::digest(tag);
    let mut h = Sha256::new();
    h.update(tag);
    h.update(tag);
    h.update(bytes);
    h.finalize().into()
}
fn reduce(mut bytes: [u8; 32]) -> [u8; 32] {
    if bytes >= ORDER {
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let v = i16::from(bytes[i]) - i16::from(ORDER[i]) - borrow;
            bytes[i] = v as u8;
            borrow = i16::from(v < 0);
        }
    }
    bytes
}
fn challenge(statement: &AuditStatement, proof: &NativeAuditProof) -> [u8; 32] {
    let mut bytes = Vec::new();
    bytes.extend(statement.deployment);
    bytes.extend(2u32.to_be_bytes());
    bytes.extend(statement.epoch.to_be_bytes());
    bytes.extend(statement.audit_key.serialize());
    bytes.extend(statement.sig_all_hash);
    bytes.extend(statement.output_index.to_be_bytes());
    bytes.extend(statement.asset);
    bytes.extend(statement.commitment.serialize());
    bytes.extend(statement.script_hash);
    bytes.push(0);
    bytes.extend(Sha256::digest(statement.auxiliary));
    bytes.extend(proof.handle.serialize());
    bytes.extend(proof.commitment_nonce.serialize());
    bytes.extend(proof.handle_nonce.serialize());
    reduce(tagged_hash(TAG, &bytes))
}
fn public_field() -> BigUint {
    BigUint::from_bytes_be(
        &hex::decode("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f")
            .expect("constant"),
    )
}
fn bytes32(value: &BigUint) -> [u8; 32] {
    let b = value.to_bytes_be();
    let mut out = [0; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

/// Decode libsecp's QR bit, which is NOT the SEC1 y-parity bit.
pub fn native_point(bytes: [u8; 33], base: u8) -> anyhow::Result<(PublicKey, [u8; 32])> {
    anyhow::ensure!(
        bytes[0] == base || bytes[0] == base + 1,
        "invalid native point prefix"
    );
    let field = public_field();
    let x = BigUint::from_bytes_be(&bytes[1..]);
    anyhow::ensure!(x < field, "noncanonical native x");
    let rhs = ((&x * &x % &field) * &x + BigUint::from(7u8)) % &field;
    let mut y = rhs.modpow(&((&field + BigUint::from(1u8)) >> 2), &field);
    anyhow::ensure!(&y * &y % &field == rhs, "native point is off curve");
    let is_square = y.modpow(&((&field - BigUint::from(1u8)) >> 1), &field) == BigUint::from(1u8);
    if is_square != (bytes[0] == base) {
        y = &field - &y;
    }
    let mut sec1 = [0; 33];
    sec1[0] = 2 + u8::from(y.bit(0));
    sec1[1..].copy_from_slice(&bytes[1..]);
    let target = if bytes[0] == base { y } else { &field - y };
    let root = target.modpow(&((&field + BigUint::from(1u8)) >> 2), &field);
    Ok((PublicKey::from_slice(&sec1)?, bytes32(&root)))
}
fn generator(asset: [u8; 32]) -> anyhow::Result<PublicKey> {
    Ok(native_point(
        Generator::new_unblinded(&Secp256k1::new(), Tag::from(asset)).serialize(),
        10,
    )?
    .0)
}
fn scale(point: PublicKey, scalar: [u8; 32]) -> anyhow::Result<Option<PublicKey>> {
    let scalar = Scalar::from_be_bytes(scalar).context("noncanonical response")?;
    if scalar == Scalar::ZERO {
        return Ok(None);
    }
    Ok(Some(
        point.mul_tweak(&Secp256k1::verification_only(), &scalar)?,
    ))
}
fn add(a: Option<PublicKey>, b: Option<PublicKey>) -> anyhow::Result<Option<PublicKey>> {
    match (a, b) {
        (None, b) => Ok(b),
        (a, None) => Ok(a),
        (Some(a), Some(b)) => match a.combine(&b) {
            Ok(p) => Ok(Some(p)),
            Err(secp256k1_zkp::UpstreamError::InvalidPublicKeySum) => Ok(None),
            Err(e) => Err(e.into()),
        },
    }
}
fn response(nonce: &SecretKey, e: [u8; 32], opening: [u8; 32]) -> anyhow::Result<[u8; 32]> {
    if e == [0; 32] {
        return Ok(nonce.secret_bytes());
    }
    let opening = Zeroizing::new(opening);
    let opening_key = ErasedSecret(SecretKey::from_slice(opening.as_ref())?);
    let product = ErasedSecret(opening_key.0.mul_tweak(&Scalar::from_be_bytes(e)?)?);
    let nonce_scalar = ErasedScalar(Scalar::from(*nonce));
    let sum = product.0.add_tweak(&nonce_scalar.0);
    match sum {
        Ok(mut sum) => {
            let out = sum.secret_bytes();
            sum.non_secure_erase();
            Ok(out)
        }
        Err(secp256k1_zkp::UpstreamError::InvalidTweak) => Ok([0; 32]),
        Err(e) => Err(e.into()),
    }
}
impl NativeAuditProof {
    pub const ENCODED_LEN: usize = 196;
    pub fn encode(&self) -> [u8; Self::ENCODED_LEN] {
        let mut out = [0; Self::ENCODED_LEN];
        out[0] = u8::from(self.commitment_parity);
        out[1..33].copy_from_slice(&self.commitment_root);
        out[33..66].copy_from_slice(&self.handle.serialize());
        out[66..99].copy_from_slice(&self.commitment_nonce.serialize());
        out[99..132].copy_from_slice(&self.handle_nonce.serialize());
        out[132..164].copy_from_slice(&self.value_response);
        out[164..].copy_from_slice(&self.blinder_response);
        out
    }
    pub fn decode(bytes: &[u8]) -> anyhow::Result<Self> {
        anyhow::ensure!(
            bytes.len() == Self::ENCODED_LEN && bytes[0] <= 1,
            "noncanonical audit proof encoding"
        );
        let value_response = bytes[132..164].try_into()?;
        let blinder_response = bytes[164..].try_into()?;
        Scalar::from_be_bytes(value_response)?;
        Scalar::from_be_bytes(blinder_response)?;
        Ok(Self {
            commitment_parity: bytes[0] == 1,
            commitment_root: bytes[1..33].try_into()?,
            handle: PublicKey::from_slice(&bytes[33..66])?,
            commitment_nonce: PublicKey::from_slice(&bytes[66..99])?,
            handle_nonce: PublicKey::from_slice(&bytes[99..132])?,
            value_response,
            blinder_response,
        })
    }
    pub fn prove<R: RngCore + CryptoRng>(
        rng: &mut R,
        statement: &AuditStatement,
        opening: &AuditOpening,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            opening.commitment(statement.asset)? == statement.commitment,
            "opening does not match native commitment"
        );
        let (c, root) = native_point(statement.commitment.serialize(), 8)?;
        let secp = Secp256k1::new();
        let h = generator(statement.asset)?;
        loop {
            let mut random_a = Zeroizing::new([0; 32]);
            let mut random_b = Zeroizing::new([0; 32]);
            rng.fill_bytes(random_a.as_mut());
            rng.fill_bytes(random_b.as_mut());
            let (Ok(mut a), Ok(mut b)) = (
                SecretKey::from_slice(random_a.as_ref()),
                SecretKey::from_slice(random_b.as_ref()),
            ) else {
                continue;
            };
            let tc = add(
                scale(h, a.secret_bytes())?,
                Some(PublicKey::from_secret_key(&secp, &b)),
            )?;
            let Some(tc) = tc else {
                a.non_secure_erase();
                b.non_secure_erase();
                continue;
            };
            let mut proof = Self {
                commitment_parity: c.serialize()[0] == 3,
                commitment_root: root,
                handle: opening.handle(statement.audit_key)?,
                commitment_nonce: tc,
                handle_nonce: statement.audit_key.mul_tweak(&secp, &Scalar::from(b))?,
                value_response: [0; 32],
                blinder_response: [0; 32],
            };
            let e = challenge(statement, &proof);
            let mut v = Zeroizing::new([0; 32]);
            v[24..].copy_from_slice(&opening.value.to_be_bytes());
            proof.value_response = response(&a, e, *v)?;
            proof.blinder_response = response(&b, e, *opening.blinder)?;
            a.non_secure_erase();
            b.non_secure_erase();
            proof.verify(statement)?;
            return Ok(proof);
        }
    }
    pub fn verify(&self, statement: &AuditStatement) -> anyhow::Result<()> {
        let (c, _) = native_point(statement.commitment.serialize(), 8)?;
        anyhow::ensure!(
            self.commitment_parity == (c.serialize()[0] == 3),
            "wrong native parity"
        );
        let field = public_field();
        let root = BigUint::from_bytes_be(&self.commitment_root);
        anyhow::ensure!(root < field, "noncanonical native root");
        let raw = c.serialize_uncompressed();
        let y = BigUint::from_bytes_be(&raw[33..]);
        let target = if statement.commitment.serialize()[0] == 8 {
            y
        } else {
            &field - y
        };
        anyhow::ensure!(&root * &root % &field == target, "wrong native root");
        let e = challenge(statement, self);
        let h = generator(statement.asset)?;
        let g = PublicKey::from_secret_key(
            &Secp256k1::new(),
            &SecretKey::from_slice(&{
                let mut a = [0; 32];
                a[31] = 1;
                a
            })?,
        );
        anyhow::ensure!(
            add(
                scale(h, self.value_response)?,
                scale(g, self.blinder_response)?
            )? == add(scale(c, e)?, Some(self.commitment_nonce))?,
            "native commitment equation failed"
        );
        anyhow::ensure!(
            scale(statement.audit_key, self.blinder_response)?
                == add(scale(self.handle, e)?, Some(self.handle_nonce))?,
            "native audit handle equation failed"
        );
        Ok(())
    }
}

fn envelope_key(shared: &SharedSecret) -> Zeroizing<[u8; 32]> {
    let mut input = Zeroizing::new(Vec::from(b"DAMP/audit/recovery-key/v2".as_slice()));
    input.extend(shared.secret_bytes());
    Zeroizing::new(Sha256::digest(&input).into())
}
/// Context excludes sig_all_hash to avoid a transaction/manifest circular hash.
pub fn recovery_context(
    deployment: [u8; 32],
    epoch: u64,
    output_index: u32,
    asset: [u8; 32],
    commitment: PedersenCommitment,
    script_hash: [u8; 32],
) -> [u8; 32] {
    let mut bytes = Vec::new();
    bytes.extend(deployment);
    bytes.extend(epoch.to_be_bytes());
    bytes.extend(output_index.to_be_bytes());
    bytes.extend(asset);
    bytes.extend(commitment.serialize());
    bytes.extend(script_hash);
    tagged_hash(b"DAMP/audit/recovery-context/v2", &bytes)
}
pub fn seal_opening<R: RngCore + CryptoRng>(
    rng: &mut R,
    key: PublicKey,
    context: [u8; 32],
    opening: &AuditOpening,
) -> anyhow::Result<[u8; AUXILIARY_BYTES]> {
    let mut secret = loop {
        let mut b = Zeroizing::new([0; 32]);
        rng.fill_bytes(b.as_mut());
        if let Ok(s) = SecretKey::from_slice(b.as_ref()) {
            break s;
        }
    };
    let public = PublicKey::from_secret_key(&Secp256k1::new(), &secret);
    let mut shared = SharedSecret::new(&key, &secret);
    secret.non_secure_erase();
    let aes = Aes256GcmSiv::new_from_slice(envelope_key(&shared).as_ref()).expect("32 byte key");
    shared.non_secure_erase();
    let mut nonce = [0; 12];
    rng.fill_bytes(&mut nonce);
    let mut plain = Zeroizing::new([0; 40]);
    plain[..8].copy_from_slice(&opening.value.to_be_bytes());
    plain[8..].copy_from_slice(opening.blinder.as_ref());
    let encrypted = aes
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain.as_ref(),
                aad: &context,
            },
        )
        .map_err(|_| anyhow::anyhow!("recovery encryption failed"))?;
    let mut out = [0; AUXILIARY_BYTES];
    out[0] = 1;
    out[1..34].copy_from_slice(&public.serialize());
    out[34..46].copy_from_slice(&nonce);
    out[46..].copy_from_slice(&encrypted);
    Ok(out)
}
/// Failure indicates unavailable/invalid recovery information, not malicious intent.
/// A caller verifies the proof and chain before presenting a recovered amount.
pub fn open_recovery(
    secret: &SecretKey,
    context: [u8; 32],
    statement: &AuditStatement,
    proof: &NativeAuditProof,
) -> anyhow::Result<AuditOpening> {
    anyhow::ensure!(
        PublicKey::from_secret_key(&Secp256k1::new(), secret) == statement.audit_key,
        "wrong audit key epoch"
    );
    anyhow::ensure!(
        statement.auxiliary[0] == 1,
        "recovery record missing or unsupported"
    );
    let public = PublicKey::from_slice(&statement.auxiliary[1..34])?;
    let mut shared = SharedSecret::new(&public, secret);
    let aes = Aes256GcmSiv::new_from_slice(envelope_key(&shared).as_ref()).expect("32 byte key");
    shared.non_secure_erase();
    let plain = Zeroizing::new(
        aes.decrypt(
            Nonce::from_slice(&statement.auxiliary[34..46]),
            Payload {
                msg: &statement.auxiliary[46..],
                aad: &context,
            },
        )
        .map_err(|_| anyhow::anyhow!("recovery authentication failed"))?,
    );
    anyhow::ensure!(plain.len() == 40, "wrong recovery opening length");
    let value = u64::from_be_bytes(plain[..8].try_into()?);
    let blinder = Zeroizing::new(<[u8; 32]>::try_from(&plain[8..])?);
    let opening = AuditOpening::from_recovered(value, *blinder)?;
    anyhow::ensure!(
        opening.commitment(statement.asset)? == statement.commitment
            && opening.handle(statement.audit_key)? == proof.handle,
        "recovered opening does not match native statement"
    );
    proof.verify(statement)?;
    Ok(opening)
}

/// Secret scalar owner. libsecp warns that erasure cannot clear compiler copies;
/// this clears owned values on every exit, not a guarantee about all stack copies.
struct ErasedSecret(SecretKey);
struct ErasedScalar(Scalar);
impl Drop for ErasedScalar {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}
impl Drop for ErasedSecret {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}

/// Invert with a fixed public exponent using libsecp secret-key multiplication.
/// No variable-time big integer operation receives the issuer private scalar.
fn inverse_secret(secret: &SecretKey) -> anyhow::Result<Zeroizing<[u8; 32]>> {
    let mut exponent = ORDER;
    exponent[31] -= 2;
    let mut power = ErasedSecret(*secret);
    let base = ErasedScalar(Scalar::from(*secret));
    for bit in 1..256 {
        let square = ErasedScalar(Scalar::from(power.0));
        power.0 = power.0.mul_tweak(&square.0)?;
        if exponent[bit / 8] & (1 << (7 - bit % 8)) != 0 {
            power.0 = power.0.mul_tweak(&base.0)?;
        }
    }
    Ok(Zeroizing::new(power.0.secret_bytes()))
}
/// Bounded fallback for invalid/missing auxiliary records. None means the chosen
/// search interval was exhausted, not that the native proof or amount is invalid.
/// Maximum bound limits each call to roughly 131,074 group operations and 65,537
/// public table entries. The full native interval is deliberately not attempted.
pub fn recover_bounded_dlp(
    secret: &SecretKey,
    statement: &AuditStatement,
    proof: &NativeAuditProof,
    upper: u64,
) -> anyhow::Result<Option<u64>> {
    anyhow::ensure!(
        upper <= (1u64 << 32),
        "DLP bound exceeds per-call resource cap"
    );
    anyhow::ensure!(
        PublicKey::from_secret_key(&Secp256k1::new(), secret) == statement.audit_key,
        "wrong audit key epoch"
    );
    proof.verify(statement)?;
    let inverse = inverse_secret(secret)?;
    let minus_blinder = proof
        .handle
        .mul_tweak(&Secp256k1::new(), &Scalar::from_be_bytes(*inverse)?)?
        .negate(&Secp256k1::new());
    let c = native_point(statement.commitment.serialize(), 8)?.0;
    let target = add(Some(c), Some(minus_blinder))?;
    let h = generator(statement.asset)?;
    let m = upper.isqrt() + 1;
    let mut table = std::collections::HashMap::with_capacity(m as usize);
    let mut point = None;
    for j in 0..m {
        table.insert(point.map(|p: PublicKey| p.serialize()), j);
        point = add(point, Some(h))?;
    }
    let step = point
        .context("DLP step is infinity")?
        .negate(&Secp256k1::new());
    let mut giant = target;
    for i in 0..=m {
        if let Some(j) = table.get(&giant.map(|p| p.serialize())) {
            let value = i
                .checked_mul(m)
                .and_then(|v| v.checked_add(*j))
                .context("DLP arithmetic overflow")?;
            if value > 0 && value <= upper {
                return Ok(Some(value));
            }
        }
        giant = add(giant, Some(step))?;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(value: u64) -> (AuditOpening, SecretKey, AuditStatement, [u8; 32]) {
        let opening = AuditOpening::new(value, [7; 32]).unwrap();
        let secret = SecretKey::from_slice(&[9; 32]).unwrap();
        let mut statement = AuditStatement {
            deployment: [42; 32],
            epoch: 1,
            audit_key: PublicKey::from_secret_key(&Secp256k1::new(), &secret),
            sig_all_hash: [3; 32],
            output_index: 2,
            asset: [17; 32],
            commitment: opening.commitment([17; 32]).unwrap(),
            script_hash: [4; 32],
            auxiliary: [0; AUXILIARY_BYTES],
        };
        let context = recovery_context(
            statement.deployment,
            statement.epoch,
            statement.output_index,
            statement.asset,
            statement.commitment,
            statement.script_hash,
        );
        statement.auxiliary = seal_opening(
            &mut rand::thread_rng(),
            statement.audit_key,
            context,
            &opening,
        )
        .unwrap();
        (opening, secret, statement, context)
    }
    #[test]
    fn actual_native_proof_and_authenticated_recovery_at_boundaries() {
        for v in [
            1,
            2,
            65535,
            1u64 << 32,
            (1u64 << 62) - 1,
            1u64 << 62,
            MAX_AUDIT_VALUE - 1,
            MAX_AUDIT_VALUE,
        ] {
            let (opening, secret, s, ctx) = fixture(v);
            let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &s, &opening).unwrap();
            assert_eq!(NativeAuditProof::decode(&proof.encode()).unwrap(), proof);
            assert_eq!(open_recovery(&secret, ctx, &s, &proof).unwrap().value(), v);
            let second = NativeAuditProof::prove(&mut rand::thread_rng(), &s, &opening).unwrap();
            assert_ne!(proof.commitment_nonce, second.commitment_nonce);
        }
        assert!(AuditOpening::new(0, [7; 32]).is_err());
        assert!(AuditOpening::new(MAX_AUDIT_VALUE + 1, [7; 32]).is_err());
        assert!(AuditOpening::new(1, [0; 32]).is_err());
    }
    #[test]
    fn native_endpoint_is_recovered_truthfully_and_bounded_dlp_exhausts() {
        let (mut opening, secret, mut statement, _) = fixture(999);
        opening.value = MAX_NATIVE_AUDIT_VALUE;
        statement.commitment = opening.commitment(statement.asset).unwrap();
        let context = recovery_context(
            statement.deployment,
            statement.epoch,
            statement.output_index,
            statement.asset,
            statement.commitment,
            statement.script_hash,
        );
        statement.auxiliary = seal_opening(
            &mut rand::thread_rng(),
            statement.audit_key,
            context,
            &opening,
        )
        .unwrap();
        let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &statement, &opening).unwrap();
        assert_eq!(
            open_recovery(&secret, context, &statement, &proof)
                .unwrap()
                .value(),
            MAX_NATIVE_AUDIT_VALUE
        );
        assert!(
            recover_bounded_dlp(&secret, &statement, &proof, 1024)
                .unwrap()
                .is_none()
        );
        let (opening, secret, mut statement, _) = fixture(999);
        statement.auxiliary = [0; AUXILIARY_BYTES];
        let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &statement, &opening).unwrap();
        assert_eq!(
            recover_bounded_dlp(&secret, &statement, &proof, 1024).unwrap(),
            Some(999)
        );
        assert_eq!(
            recover_bounded_dlp(&secret, &statement, &proof, 998).unwrap(),
            None
        );
        assert!(recover_bounded_dlp(&secret, &statement, &proof, (1u64 << 32) + 1).is_err());
    }
    #[test]
    fn mutations_reject_and_missing_recovery_does_not_veto_native_proof() {
        let (opening, secret, s, ctx) = fixture(999);
        let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &s, &opening).unwrap();
        for kind in 0..8 {
            let mut changed = s.clone();
            match kind {
                0 => changed.output_index += 1,
                1 => changed.epoch += 1,
                2 => changed.deployment[0] ^= 1,
                3 => changed.sig_all_hash[0] ^= 1,
                4 => changed.asset[0] ^= 1,
                5 => changed.script_hash[0] ^= 1,
                6 => changed.auxiliary[90] ^= 1,
                _ => {
                    changed.audit_key = PublicKey::from_secret_key(
                        &Secp256k1::new(),
                        &SecretKey::from_slice(&[6; 32]).unwrap(),
                    )
                }
            };
            assert!(proof.verify(&changed).is_err());
        }
        let mut bad = proof.clone();
        bad.value_response = ORDER;
        assert!(bad.verify(&s).is_err());
        assert!(NativeAuditProof::decode(&bad.encode()).is_err());
        let mut bad = proof.clone();
        bad.commitment_parity = !bad.commitment_parity;
        assert!(bad.verify(&s).is_err());
        let mut missing = s.clone();
        missing.auxiliary = [0; AUXILIARY_BYTES];
        let p = NativeAuditProof::prove(&mut rand::thread_rng(), &missing, &opening).unwrap();
        p.verify(&missing).unwrap();
        assert!(open_recovery(&secret, ctx, &missing, &p).is_err());
        let mut corrupt = s.clone();
        corrupt.auxiliary[90] ^= 1;
        let p = NativeAuditProof::prove(&mut rand::thread_rng(), &corrupt, &opening).unwrap();
        p.verify(&corrupt).unwrap();
        assert!(open_recovery(&secret, ctx, &corrupt, &p).is_err());
    }
}
