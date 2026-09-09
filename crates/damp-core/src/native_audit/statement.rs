use secp256k1_zkp::{PedersenCommitment, PublicKey};
use sha2::{Digest, Sha256};

use super::{AuditError, point};
use crate::{
    encoding::hex_value,
    ledger::{AssetId, AuditPublicKey},
    registry::{AuditEpoch, DeploymentSalt, NativeAuditConfig, ScriptHash},
};

pub const AUXILIARY_BYTES: usize = 102;
hex_value!(
    SigAllHash,
    "sig_all hash",
    "Transaction-wide Simplicity signature digest."
);

/// Deployment-scoped public parameters shared by every audit statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditDomain {
    deployment: DeploymentSalt,
    config: NativeAuditConfig,
}
impl AuditDomain {
    pub const fn new(deployment: DeploymentSalt, config: NativeAuditConfig) -> Self {
        Self { deployment, config }
    }
    pub const fn deployment(self) -> DeploymentSalt {
        self.deployment
    }
    pub const fn epoch(self) -> AuditEpoch {
        self.config.epoch
    }
    pub const fn key(self) -> AuditPublicKey {
        self.config.public_key
    }
}

/// Fixed-size public recovery bytes, which may be missing or fail authentication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuxiliaryRecord([u8; AUXILIARY_BYTES]);
impl AuxiliaryRecord {
    pub const MISSING: Self = Self([0; AUXILIARY_BYTES]);
    pub const fn from_byte_array(bytes: [u8; AUXILIARY_BYTES]) -> Self {
        Self(bytes)
    }
    pub const fn to_byte_array(self) -> [u8; AUXILIARY_BYTES] {
        self.0
    }
    pub fn is_missing(&self) -> bool {
        self == &Self::MISSING
    }
}
impl AsRef<[u8]> for AuxiliaryRecord {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// An output with its native commitment and asset generator decoded once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditOutput {
    index: u32,
    asset: AssetId,
    consensus_asset: [u8; 32],
    commitment: PedersenCommitment,
    script_hash: ScriptHash,
    point: point::NativePoint,
    generator: PublicKey,
}
impl AuditOutput {
    /// Parse the native commitment for an output after the verifier anchor.
    ///
    /// # Errors
    /// Rejects output zero or a noncanonical native curve encoding.
    pub fn new(
        index: u32,
        asset: AssetId,
        commitment: PedersenCommitment,
        script_hash: ScriptHash,
    ) -> Result<Self, AuditError> {
        if index == 0 {
            return Err(crate::error::ParseError::Bound {
                field: "audit output index",
                minimum: 1,
                maximum: u32::MAX as u64,
            }
            .into());
        }
        let consensus_asset = asset.to_consensus_byte_array();
        Ok(Self {
            index,
            asset,
            consensus_asset,
            commitment,
            script_hash,
            point: point::commitment_point(commitment)?,
            generator: point::generator(consensus_asset)?,
        })
    }
    pub const fn index(self) -> u32 {
        self.index
    }
    pub const fn asset(self) -> AssetId {
        self.asset
    }
    pub const fn commitment(self) -> PedersenCommitment {
        self.commitment
    }
    pub const fn script_hash(self) -> ScriptHash {
        self.script_hash
    }
    pub(super) const fn point(self) -> point::NativePoint {
        self.point
    }
    pub(super) const fn generator(self) -> PublicKey {
        self.generator
    }
    pub(super) const fn consensus_asset(self) -> [u8; 32] {
        self.consensus_asset
    }
}

/// Immutable public inputs to one audit proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditStatement {
    domain: AuditDomain,
    output: AuditOutput,
    sig_all_hash: SigAllHash,
    auxiliary: AuxiliaryRecord,
}
impl AuditStatement {
    /// Bind the completed output and recovery record to the final transaction digest.
    pub const fn new(
        domain: AuditDomain,
        output: AuditOutput,
        sig_all_hash: SigAllHash,
        auxiliary: AuxiliaryRecord,
    ) -> Self {
        Self {
            domain,
            output,
            sig_all_hash,
            auxiliary,
        }
    }
    pub const fn domain(&self) -> AuditDomain {
        self.domain
    }
    pub const fn output(&self) -> AuditOutput {
        self.output
    }
    pub const fn sig_all_hash(&self) -> SigAllHash {
        self.sig_all_hash
    }
    pub const fn auxiliary(&self) -> AuxiliaryRecord {
        self.auxiliary
    }
}

pub(super) fn tagged_hash(tag: &[u8], bytes: &[u8]) -> [u8; 32] {
    let tag = Sha256::digest(tag);
    let mut hasher = Sha256::new();
    hasher.update(tag);
    hasher.update(tag);
    hasher.update(bytes);
    hasher.finalize().into()
}

// Excludes sig_all_hash because recovery bytes enter the transaction manifest.
pub(super) fn recovery_context(domain: AuditDomain, output: AuditOutput) -> [u8; 32] {
    let mut bytes = Vec::new();
    bytes.extend(domain.deployment().to_byte_array());
    bytes.extend(domain.epoch().get().to_be_bytes());
    bytes.extend(output.index().to_be_bytes());
    bytes.extend(output.consensus_asset());
    bytes.extend(output.commitment().serialize());
    bytes.extend(output.script_hash().to_byte_array());
    tagged_hash(b"DAMP/audit/recovery-context/v2", &bytes)
}
