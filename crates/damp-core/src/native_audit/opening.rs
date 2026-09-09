use secp256k1_zkp::{
    Generator, PedersenCommitment, PublicKey, Scalar, Secp256k1, SecretKey, Tag, Tweak,
};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::{AuditError, scalar::ErasedSecret};
use crate::ledger::{AssetId, AuditAmount, AuditPublicKey};

/// Native range proofs also accept this inclusive upper endpoint.
pub const MAX_NATIVE_AUDIT_VALUE: u64 = 1 << 63;

/// A recovered amount in the native interval, including its upper endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct NativeAuditAmount(u64);

impl NativeAuditAmount {
    pub const fn get(self) -> u64 {
        self.0
    }
    pub fn application_amount(self) -> Option<AuditAmount> {
        self.0.try_into().ok()
    }
}
impl TryFrom<u64> for NativeAuditAmount {
    type Error = AuditError;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if !(1..=MAX_NATIVE_AUDIT_VALUE).contains(&value) {
            return Err(AuditError::NativeAmount);
        }
        Ok(Self(value))
    }
}
impl From<AuditAmount> for NativeAuditAmount {
    fn from(value: AuditAmount) -> Self {
        Self(value.get())
    }
}
impl std::str::FromStr for NativeAuditAmount {
    type Err = AuditError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let value: crate::ledger::Amount = value.parse()?;
        value.get().try_into()
    }
}
impl TryFrom<String> for NativeAuditAmount {
    type Error = AuditError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<NativeAuditAmount> for String {
    fn from(value: NativeAuditAmount) -> Self {
        value.to_string()
    }
}
impl std::fmt::Display for NativeAuditAmount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// A checked opening. Debug omits secrets; Drop overwrites its owned value and blinder.
/// Compiler and dependency copies may remain.
pub struct AuditOpening {
    value: NativeAuditAmount,
    blinder: ErasedSecret,
}
impl std::fmt::Debug for AuditOpening {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AuditOpening([REDACTED])")
    }
}
impl Drop for AuditOpening {
    fn drop(&mut self) {
        self.value.0.zeroize();
    }
}
impl AuditOpening {
    /// Construct an application-bounded opening.
    ///
    /// # Errors
    /// Returns `AuditError::Blinder` for a zero or noncanonical blinding scalar.
    pub fn new(value: AuditAmount, blinder: Tweak) -> Result<Self, AuditError> {
        Self::from_recovered(value.into(), *blinder.as_ref())
    }
    pub(super) fn from_recovered(
        value: NativeAuditAmount,
        blinder: [u8; 32],
    ) -> Result<Self, AuditError> {
        let bytes = Zeroizing::new(blinder);
        let blinder =
            ErasedSecret(SecretKey::from_slice(bytes.as_ref()).map_err(|_| AuditError::Blinder)?);
        Ok(Self { value, blinder })
    }
    pub const fn value(&self) -> NativeAuditAmount {
        self.value
    }
    pub(super) fn blinder(&self) -> &SecretKey {
        &self.blinder.0
    }
    pub fn commitment(&self, asset: AssetId) -> Result<PedersenCommitment, AuditError> {
        let bytes = Zeroizing::new(self.blinder.0.secret_bytes());
        let tweak = Tweak::from_slice(bytes.as_ref()).map_err(|_| AuditError::Blinder)?;
        Ok(PedersenCommitment::new(
            &Secp256k1::new(),
            self.value.get(),
            tweak,
            Generator::new_unblinded(
                &Secp256k1::new(),
                Tag::from(asset.to_consensus_byte_array()),
            ),
        ))
    }
    pub fn handle(&self, key: AuditPublicKey) -> Result<PublicKey, AuditError> {
        let scalar = super::scalar::ErasedScalar(Scalar::from(self.blinder.0));
        Ok(key
            .public_key()
            .mul_tweak(&Secp256k1::verification_only(), &scalar.0)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        native_audit::{AuditDomain, AuditOutput, AuditStatement, NativeAuditProof},
        registry::{AuditEpoch, DeploymentSalt, NativeAuditConfig},
    };

    #[test]
    fn recovery_accepts_the_native_endpoint_without_constructing_an_application_amount() {
        let opening =
            AuditOpening::from_recovered(MAX_NATIVE_AUDIT_VALUE.try_into().unwrap(), [7; 32])
                .unwrap();
        let secret = SecretKey::from_slice(&[9; 32]).unwrap();
        let domain = AuditDomain::new(
            DeploymentSalt::try_from([42; 32]).unwrap(),
            NativeAuditConfig {
                public_key: PublicKey::from_secret_key(&Secp256k1::new(), &secret).into(),
                epoch: AuditEpoch::INITIAL,
            },
        );
        let asset = AssetId::from_byte_array([17; 32]);
        let output =
            AuditOutput::new(2, asset, opening.commitment(asset).unwrap(), [4; 32].into()).unwrap();
        let auxiliary = output
            .seal(&mut rand::thread_rng(), domain, &opening)
            .unwrap();
        let statement = AuditStatement::new(domain, output, [3; 32].into(), auxiliary);
        let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &statement, &opening).unwrap();
        let key = domain.bind_secret(&secret).unwrap();
        let recovered = proof.open_recovery(&key).unwrap().value();
        assert_eq!(recovered.get(), MAX_NATIVE_AUDIT_VALUE);
        assert!(recovered.application_amount().is_none());
        assert!(
            proof
                .recover_bounded(&key, 1024.try_into().unwrap())
                .unwrap()
                .is_none()
        );
    }
}
