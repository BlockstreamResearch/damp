use aes_gcm_siv::{
    Aes256GcmSiv, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use rand::{CryptoRng, RngCore};
use secp256k1_zkp::{PublicKey, Secp256k1, SecretKey, ecdh::SharedSecret};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::{
    AUXILIARY_BYTES, AuditDomain, AuditError, AuditOpening, AuditOutput, AuxiliaryRecord,
    NativeAuditAmount, VerifiedAuditProof,
    point::add,
    scalar::{ErasedSecret, inverse},
    statement::recovery_context,
};

/// Search interval `1..=upper`, capped at `2^32` to bound memory and curve work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct RecoveryBound(u64);
impl RecoveryBound {
    pub const MAX: u64 = 1 << 32;
    pub const fn get(self) -> u64 {
        self.0
    }
}
impl TryFrom<u64> for RecoveryBound {
    type Error = AuditError;
    fn try_from(upper: u64) -> Result<Self, Self::Error> {
        if !(1..=Self::MAX).contains(&upper) {
            return Err(AuditError::RecoveryBound);
        }
        Ok(Self(upper))
    }
}
impl From<RecoveryBound> for u64 {
    fn from(bound: RecoveryBound) -> Self {
        bound.0
    }
}

/// A borrowed issuer secret checked against one deployment's audit key and epoch.
pub struct AuditSecret<'a> {
    domain: AuditDomain,
    secret: &'a SecretKey,
}
impl std::fmt::Debug for AuditSecret<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditSecret")
            .field("domain", &self.domain)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}
impl AuditDomain {
    /// Bind a parsed issuer secret to this domain.
    ///
    /// # Errors
    /// Returns `AuditError::AuditKey` if its public key differs from the domain key.
    pub fn bind_secret(self, secret: &SecretKey) -> Result<AuditSecret<'_>, AuditError> {
        if PublicKey::from_secret_key(&Secp256k1::new(), secret) != self.key().public_key() {
            return Err(AuditError::AuditKey);
        }
        Ok(AuditSecret {
            domain: self,
            secret,
        })
    }
}
impl AuditSecret<'_> {
    fn check(&self, proof: &VerifiedAuditProof<'_>) -> Result<(), AuditError> {
        if self.domain != proof.statement().domain() {
            return Err(AuditError::AuditKey);
        }
        Ok(())
    }
}

struct ErasedShared(SharedSecret);
impl Drop for ErasedShared {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}

fn envelope_cipher(shared: &SharedSecret) -> Aes256GcmSiv {
    let mut input = Zeroizing::new(Vec::from(b"DAMP/audit/recovery-key/v2".as_slice()));
    input.extend(shared.secret_bytes());
    let key = Zeroizing::new(<[u8; 32]>::from(Sha256::digest(&input)));
    Aes256GcmSiv::new((&*key).into())
}

impl AuditOutput {
    /// Encrypt this output's opening before constructing the manifest and sighash.
    ///
    /// # Errors
    /// Rejects a different opening or failed authenticated encryption.
    pub fn seal<R: RngCore + CryptoRng>(
        self,
        rng: &mut R,
        domain: AuditDomain,
        opening: &AuditOpening,
    ) -> Result<AuxiliaryRecord, AuditError> {
        if opening.commitment(self.asset())? != self.commitment() {
            return Err(AuditError::CommitmentMismatch);
        }
        let secret = ErasedSecret::random(rng);
        let public = PublicKey::from_secret_key(&Secp256k1::new(), &secret.0);
        let shared = ErasedShared(SharedSecret::new(&domain.key().public_key(), &secret.0));
        let cipher = envelope_cipher(&shared.0);
        let mut nonce = [0; 12];
        rng.fill_bytes(&mut nonce);
        let mut plain = Zeroizing::new([0; 40]);
        plain[..8].copy_from_slice(&opening.value().get().to_be_bytes());
        let blinder = Zeroizing::new(opening.blinder().secret_bytes());
        plain[8..].copy_from_slice(blinder.as_ref());
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plain.as_ref(),
                    aad: &recovery_context(domain, self),
                },
            )
            .map_err(|_| AuditError::Encryption)?;
        let mut out = [0; AUXILIARY_BYTES];
        out[0] = 1;
        out[1..34].copy_from_slice(&public.serialize());
        out[34..46].copy_from_slice(&nonce);
        out[46..].copy_from_slice(&encrypted);
        Ok(AuxiliaryRecord::from_byte_array(out))
    }
}

impl VerifiedAuditProof<'_> {
    /// Authenticate recovery bytes and match the recovered opening to both equations.
    ///
    /// # Errors
    /// Rejects another domain's key, missing/invalid ciphertext, or a mismatched opening.
    /// Recovery failure alone says nothing about malicious intent.
    pub fn open_recovery(&self, secret: &AuditSecret<'_>) -> Result<AuditOpening, AuditError> {
        secret.check(self)?;
        let statement = self.statement();
        let auxiliary = statement.auxiliary();
        let bytes = auxiliary.as_ref();
        if bytes[0] != 1 {
            return Err(AuditError::RecoveryRecord);
        }
        let public = PublicKey::from_slice(&bytes[1..34]).map_err(|_| AuditError::RecoveryKey)?;
        let shared = ErasedShared(SharedSecret::new(&public, secret.secret));
        let plain = Zeroizing::new(
            envelope_cipher(&shared.0)
                .decrypt(
                    Nonce::from_slice(&bytes[34..46]),
                    Payload {
                        msg: &bytes[46..],
                        aad: &recovery_context(statement.domain(), statement.output()),
                    },
                )
                .map_err(|_| AuditError::Authentication)?,
        );
        let plain: &[u8; 40] = plain
            .as_slice()
            .try_into()
            .map_err(|_| AuditError::RecoveryLength)?;
        let value = u64::from_be_bytes(
            plain[..8]
                .try_into()
                .map_err(|_| AuditError::RecoveryLength)?,
        );
        let blinder = Zeroizing::new(
            <[u8; 32]>::try_from(&plain[8..]).map_err(|_| AuditError::RecoveryLength)?,
        );
        let opening = AuditOpening::from_recovered(value.try_into()?, *blinder)?;
        if opening.commitment(statement.output().asset())? != statement.output().commitment()
            || opening.handle(statement.domain().key())? != self.proof().handle()
        {
            return Err(AuditError::RecoveredOpening);
        }
        Ok(opening)
    }

    /// Recover within the chosen interval using at most 65,537 public table entries.
    ///
    /// `None` means the search was exhausted, not that the amount or proof is invalid.
    ///
    /// # Errors
    /// Rejects another domain's key or a failed curve/arithmetic operation.
    pub fn recover_bounded(
        &self,
        secret: &AuditSecret<'_>,
        upper: RecoveryBound,
    ) -> Result<Option<NativeAuditAmount>, AuditError> {
        secret.check(self)?;
        let secp = Secp256k1::new();
        let inverse = inverse(secret.secret)?;
        let minus_blinder = self
            .proof()
            .handle()
            .mul_tweak(&secp, &inverse.0)?
            .negate(&secp);
        let output = self.statement().output();
        let target = add(Some(output.point().key), Some(minus_blinder))?;
        let h = output.generator();
        let m = upper.get().isqrt() + 1;
        let mut table = std::collections::HashMap::with_capacity(m as usize);
        let mut point = None;
        for j in 0..m {
            table.insert(point.map(|p: PublicKey| p.serialize()), j);
            point = add(point, Some(h))?;
        }
        let step = point.ok_or(AuditError::SearchInfinity)?.negate(&secp);
        let mut giant = target;
        for i in 0..=m {
            if let Some(j) = table.get(&giant.map(|p| p.serialize())) {
                let value = i
                    .checked_mul(m)
                    .and_then(|v| v.checked_add(*j))
                    .ok_or(AuditError::SearchArithmetic)?;
                if value > 0 && value <= upper.get() {
                    return Ok(Some(value.try_into()?));
                }
            }
            giant = add(giant, Some(step))?;
        }
        Ok(None)
    }
}
