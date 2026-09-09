use crate::keys::KeyIndex;
use crate::utxo::input::Utxo;
use damp_core::ledger::{Amount, AssetId, AuditAmount};
use damp_core::policy::{SetCommitment, TreeDepth};
use damp_core::registry::{
    AssetMetadata, DeploymentManifest, DeploymentNetwork, DeploymentSalt, PolicySnapshot,
    SupplyMode,
};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "PreparePolicyFields")]
pub struct PreparePolicyRequest {
    pub deployment: DeploymentManifest,
    pub policy: SetCommitment,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparePolicyFields {
    pub deployment: DeploymentManifest,
    pub tree_depth: TreeDepth,
    pub set_root: damp_core::registry::SetRoot,
    pub entry_count: u32,
}
impl TryFrom<PreparePolicyFields> for PreparePolicyRequest {
    type Error = damp_core::policy::PolicyError;
    fn try_from(fields: PreparePolicyFields) -> Result<Self, Self::Error> {
        Ok(Self {
            deployment: fields.deployment,
            policy: SetCommitment::new(fields.tree_depth, fields.set_root, fields.entry_count)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferRequest {
    pub deployment: DeploymentManifest,
    pub current_policy: PolicySnapshot,
    pub verifier_utxo: Utxo,
    pub regulated_utxos: Vec<Utxo>,
    pub fee_utxos: Vec<Utxo>,
    pub recipient_address: crate::keys::ConfidentialAddress,
    pub amount: AuditAmount,
    pub fee: Amount,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyUpdateRequest {
    pub deployment: DeploymentManifest,
    pub current_policy: PolicySnapshot,
    pub successor_policy: PolicySnapshot,
    pub verifier_utxo: Utxo,
    pub fee_utxos: Vec<Utxo>,
    pub fee: Amount,
    pub issuer_derivation_index: KeyIndex,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapRequest {
    pub network: DeploymentNetwork,
    pub policy_asset: AssetId,
    pub deployment_salt: DeploymentSalt,
    pub asset: AssetMetadata,
    pub issued_supply: AuditAmount,
    pub supply_mode: SupplyMode,
    pub policy_utxos: Vec<Utxo>,
    pub fee: Amount,
    pub required_confirmations: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitFundingRequest {
    pub network: DeploymentNetwork,
    pub policy_asset: AssetId,
    pub source_utxos: Vec<Utxo>,
    pub fee: Amount,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReissuanceRequest {
    pub deployment: DeploymentManifest,
    pub current_policy: PolicySnapshot,
    pub verifier_utxo: Utxo,
    pub token_utxo: Utxo,
    pub fee_utxos: Vec<Utxo>,
    pub recipient_address: crate::keys::ConfidentialAddress,
    pub amount: AuditAmount,
    pub fee: Amount,
    pub issuer_derivation_index: KeyIndex,
}
