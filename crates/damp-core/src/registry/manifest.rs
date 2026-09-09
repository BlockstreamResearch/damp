use super::wire::ManifestFields;
use super::{
    AssetMetadata, BundleHash, DeploymentId, DeploymentNetwork, DeploymentSalt, NativeAuditConfig,
    PROTOCOL_ID, ProgramHash, REGISTRY_SCHEMA, RegistryError, Supply,
};
use crate::ledger::{AssetId, AuditAmount, Outpoint, XOnlyKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Immutable deployment parameters, parsed and checked before use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ManifestFields", into = "ManifestFields")]
pub struct DeploymentManifest {
    network: DeploymentNetwork,
    policy_asset: AssetId,
    regulated_asset: AssetId,
    verifier_asset: AssetId,
    issuer_public_key: XOnlyKey,
    deployment_salt: DeploymentSalt,
    genesis_anchor: Outpoint,
    asset: AssetMetadata,
    issued_supply: AuditAmount,
    supply: Supply,
    user_program_hash: ProgramHash,
    governance_program_hash: ProgramHash,
    contract_bundle_hash: BundleHash,
    audit: NativeAuditConfig,
}

impl TryFrom<ManifestFields> for DeploymentManifest {
    type Error = RegistryError;
    fn try_from(value: ManifestFields) -> Result<Self, Self::Error> {
        if value.schema != REGISTRY_SCHEMA {
            return Err(RegistryError::Schema);
        }
        if value.protocol != PROTOCOL_ID {
            return Err(RegistryError::Protocol);
        }
        if value.verifier_asset_amount != 1 {
            return Err(RegistryError::AnchorQuantity);
        }
        if value.policy_asset == value.regulated_asset
            || value.policy_asset == value.verifier_asset
            || value.regulated_asset == value.verifier_asset
        {
            return Err(RegistryError::AssetCollision);
        }
        let supply = Supply::from_fields(
            value.supply_mode,
            value.reissuance_token,
            value.reissuance_entropy,
        )?;
        Ok(Self {
            network: value.network,
            policy_asset: value.policy_asset,
            regulated_asset: value.regulated_asset,
            verifier_asset: value.verifier_asset,
            issuer_public_key: value.issuer_public_key,
            deployment_salt: value.deployment_salt,
            genesis_anchor: value.genesis_anchor,
            asset: value.asset,
            issued_supply: value.issued_supply,
            supply,
            user_program_hash: value.user_program_hash,
            governance_program_hash: value.governance_program_hash,
            contract_bundle_hash: value.contract_bundle_hash,
            audit: value.audit,
        })
    }
}

impl DeploymentManifest {
    pub const fn network(&self) -> DeploymentNetwork {
        self.network
    }
    pub const fn policy_asset(&self) -> AssetId {
        self.policy_asset
    }
    pub const fn regulated_asset(&self) -> AssetId {
        self.regulated_asset
    }
    pub const fn verifier_asset(&self) -> AssetId {
        self.verifier_asset
    }
    pub const fn verifier_asset_amount(&self) -> u64 {
        1
    }
    pub const fn issuer_public_key(&self) -> XOnlyKey {
        self.issuer_public_key
    }
    pub const fn deployment_salt(&self) -> DeploymentSalt {
        self.deployment_salt
    }
    pub const fn genesis_anchor(&self) -> Outpoint {
        self.genesis_anchor
    }
    pub fn asset(&self) -> &AssetMetadata {
        &self.asset
    }
    pub const fn issued_supply(&self) -> AuditAmount {
        self.issued_supply
    }
    pub const fn supply(&self) -> Supply {
        self.supply
    }
    pub const fn user_program_hash(&self) -> ProgramHash {
        self.user_program_hash
    }
    pub const fn governance_program_hash(&self) -> ProgramHash {
        self.governance_program_hash
    }
    pub const fn contract_bundle_hash(&self) -> BundleHash {
        self.contract_bundle_hash
    }
    pub const fn audit(&self) -> NativeAuditConfig {
        self.audit
    }

    /// Hash the validated bound fields in the protocol's fixed order.
    pub fn deployment_id(&self) -> DeploymentId {
        let mut hasher = Sha256::new();
        for value in [
            REGISTRY_SCHEMA.to_owned(),
            PROTOCOL_ID.to_owned(),
            self.network.as_str().to_owned(),
            self.policy_asset.to_string(),
            self.regulated_asset.to_string(),
            self.verifier_asset.to_string(),
            self.issuer_public_key.to_string(),
            self.deployment_salt.to_string(),
            self.genesis_anchor.to_string(),
            self.asset.name().to_owned(),
            self.asset.ticker().to_owned(),
            self.user_program_hash.to_string(),
            self.governance_program_hash.to_string(),
            self.contract_bundle_hash.to_string(),
            self.supply
                .token()
                .map(|value| value.to_string())
                .unwrap_or_default(),
            self.supply
                .entropy()
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ] {
            hash_text(&mut hasher, value.as_bytes());
        }
        hasher.update(1u64.to_be_bytes());
        hasher.update(self.issued_supply.get().to_be_bytes());
        hasher.update([self.asset.precision()]);
        hasher.update([match self.supply {
            Supply::Fixed => 0,
            Supply::IssuerManaged { .. } => 1,
        }]);
        hash_text(&mut hasher, self.audit.public_key.to_string().as_bytes());
        hasher.update(self.audit.epoch.get().to_be_bytes());
        DeploymentId::from(<[u8; 32]>::from(hasher.finalize()))
    }
}

fn hash_text(hasher: &mut Sha256, bytes: &[u8]) {
    // Every field is a bounded encoding or validated display string.
    hasher.update((bytes.len() as u32).to_be_bytes());
    hasher.update(bytes);
}

impl From<DeploymentManifest> for ManifestFields {
    fn from(value: DeploymentManifest) -> Self {
        Self {
            schema: REGISTRY_SCHEMA.to_owned(),
            protocol: PROTOCOL_ID.to_owned(),
            network: value.network,
            policy_asset: value.policy_asset,
            regulated_asset: value.regulated_asset,
            verifier_asset: value.verifier_asset,
            verifier_asset_amount: 1,
            issuer_public_key: value.issuer_public_key,
            deployment_salt: value.deployment_salt,
            genesis_anchor: value.genesis_anchor,
            asset: value.asset,
            issued_supply: value.issued_supply,
            supply_mode: value.supply.mode(),
            reissuance_token: value.supply.token(),
            reissuance_entropy: value.supply.entropy(),
            user_program_hash: value.user_program_hash,
            governance_program_hash: value.governance_program_hash,
            contract_bundle_hash: value.contract_bundle_hash,
            audit: value.audit,
        }
    }
}
