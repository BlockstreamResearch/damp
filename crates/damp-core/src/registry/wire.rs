//! JSON fields before cross-field manifest validation.

use super::{
    AssetMetadata, BundleHash, DeploymentNetwork, DeploymentSalt, IssuanceEntropy,
    NativeAuditConfig, ProgramHash, SupplyMode,
};
use crate::ledger::{AssetId, AuditAmount, Outpoint, XOnlyKey};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestFields {
    pub schema: String,
    pub protocol: String,
    pub network: DeploymentNetwork,
    pub policy_asset: AssetId,
    pub regulated_asset: AssetId,
    pub verifier_asset: AssetId,
    pub verifier_asset_amount: u64,
    pub issuer_public_key: XOnlyKey,
    pub deployment_salt: DeploymentSalt,
    pub genesis_anchor: Outpoint,
    pub asset: AssetMetadata,
    pub issued_supply: AuditAmount,
    pub supply_mode: SupplyMode,
    #[serde(deserialize_with = "required_nullable")]
    pub reissuance_token: Option<AssetId>,
    #[serde(deserialize_with = "required_nullable")]
    pub reissuance_entropy: Option<IssuanceEntropy>,
    pub user_program_hash: ProgramHash,
    pub governance_program_hash: ProgramHash,
    pub contract_bundle_hash: BundleHash,
    pub audit: NativeAuditConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotFields {
    pub schema: String,
    pub protocol: String,
    pub deployment_id: super::DeploymentId,
    pub sequence: u64,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_policy_root: Option<super::PolicyRoot>,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_verifier_script_hash: Option<super::ScriptHash>,
    pub tree_depth: crate::policy::TreeDepth,
    pub set_root: super::SetRoot,
    pub entry_count: u32,
    pub policy_root: super::PolicyRoot,
    pub verifier_program_hash: ProgramHash,
    pub verifier_script_pubkey: crate::ledger::ScriptPubkey,
    pub entries: Vec<super::BlacklistEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlacklistFields {
    pub txid: crate::ledger::Txid,
    pub vout: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn required_nullable<'de, D, T>(decoder: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(decoder)
}
