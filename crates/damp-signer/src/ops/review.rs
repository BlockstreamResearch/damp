use crate::keys::KeyIndex;
use crate::keys::WalletKeyLocator;
use crate::keys::info::DerivedHolderAddress;
use damp_core::policy::TreeDepth;
use damp_core::registry::{DeploymentManifest, PolicySnapshot};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPolicy {
    pub sdk: &'static str,
    pub policy_root: damp_core::registry::PolicyRoot,
    pub verifier_program_hash: damp_core::registry::ProgramHash,
    pub verifier_script_pubkey: damp_core::ledger::ScriptPubkey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReview {
    pub deployment_id: damp_core::registry::DeploymentId,
    pub operation: &'static str,
    pub regulated_amount: String,
    pub fee: damp_core::ledger::Amount,
    pub input_count: usize,
    pub output_count: usize,
    pub current_depth: TreeDepth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub successor_depth: Option<TreeDepth>,
    pub recipients: Vec<crate::keys::ConfidentialAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedOperation {
    pub sdk: &'static str,
    pub operation: &'static str,
    pub pset: String,
    pub transaction: String,
    pub txid: String,
    pub review: OperationReview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResult {
    pub sdk: &'static str,
    pub operation: &'static str,
    pub pset: String,
    pub transaction: String,
    pub txid: String,
    pub review: OperationReview,
    pub deployment: DeploymentManifest,
    pub deployment_id: damp_core::registry::DeploymentId,
    pub initial_policy: PolicySnapshot,
    pub initial_holder_address: DerivedHolderAddress,
    pub issuer_derivation_index: KeyIndex,
    pub holder_derivation_index: KeyIndex,
    pub required_confirmations: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitFundingOutput {
    pub vout: u32,
    pub amount: String,
    pub confidential_address: crate::keys::ConfidentialAddress,
    pub wallet_key: WalletKeyLocator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitFundingResult {
    pub sdk: &'static str,
    pub operation: &'static str,
    pub pset: String,
    pub transaction: String,
    pub txid: String,
    pub source_txid: String,
    pub source_vout: u32,
    pub source_amount: String,
    pub fee: damp_core::ledger::Amount,
    pub outputs: Vec<SplitFundingOutput>,
}
