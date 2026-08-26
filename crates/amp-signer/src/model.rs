use amp_core::policy::TreeDepth;
use amp_core::registry::{
    AssetMetadata, DeploymentManifestV1, DeploymentNetwork, PolicySnapshotV1, SupplyMode,
};
use serde::{Deserialize, Serialize};

pub const SIGNER_SDK_VERSION: &str = "simplicity-amp-signer/v0.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignerNetwork {
    LiquidTestnet,
    ElementsRegtest,
}

impl SignerNetwork {
    pub const fn is_mainnet(self) -> bool {
        false
    }

    pub const fn address_params(self) -> &'static elements::AddressParams {
        match self {
            Self::LiquidTestnet => &elements::AddressParams::LIQUID_TESTNET,
            Self::ElementsRegtest => &elements::AddressParams::ELEMENTS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparePolicyRequest {
    pub deployment: DeploymentManifestV1,
    pub tree_depth: TreeDepth,
    pub set_root: String,
    pub entry_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPolicy {
    pub sdk: &'static str,
    pub policy_root: String,
    pub verifier_program_hash: String,
    pub verifier_script_pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedHolderAddress {
    pub sdk: &'static str,
    pub derivation_index: u32,
    pub owner_public_key: String,
    pub script_pubkey: String,
    pub confidential_address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedAmpKey {
    pub sdk: &'static str,
    pub derivation_index: u32,
    pub derivation_path: String,
    pub public_key: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedWalletAddress {
    pub sdk: &'static str,
    pub branch: u32,
    pub index: u32,
    pub derivation_path: String,
    pub confidential_address: String,
    pub script_pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerInfo {
    pub sdk: &'static str,
    pub fingerprint: String,
    pub descriptor: String,
    pub network: SignerNetwork,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletKeyLocator {
    pub branch: u32,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HolderKeyLocator {
    pub derivation_index: u32,
    pub owner_public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpendableUtxo {
    pub txid: String,
    pub vout: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_out: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<String>,
    pub spendable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_key: Option<WalletKeyLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder_key: Option<HolderKeyLocator>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedUtxo {
    pub txid: String,
    pub vout: u32,
    pub asset_id: String,
    pub amount: String,
    pub script_pubkey: String,
    pub asset_confidential: bool,
    pub value_confidential: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferRequest {
    pub deployment: DeploymentManifestV1,
    pub current_policy: PolicySnapshotV1,
    pub verifier_utxo: SpendableUtxo,
    pub regulated_utxos: Vec<SpendableUtxo>,
    pub fee_utxos: Vec<SpendableUtxo>,
    pub recipient_address: String,
    pub amount: String,
    pub fee: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyUpdateRequest {
    pub deployment: DeploymentManifestV1,
    pub current_policy: PolicySnapshotV1,
    pub successor_policy: PolicySnapshotV1,
    pub verifier_utxo: SpendableUtxo,
    pub fee_utxos: Vec<SpendableUtxo>,
    pub fee: String,
    pub issuer_derivation_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReview {
    pub deployment_id: String,
    pub operation: &'static str,
    pub regulated_amount: String,
    pub fee: String,
    pub input_count: usize,
    pub output_count: usize,
    pub current_depth: TreeDepth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub successor_depth: Option<TreeDepth>,
    pub recipients: Vec<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapRequest {
    pub network: DeploymentNetwork,
    pub policy_asset: String,
    pub deployment_salt: String,
    pub asset: AssetMetadata,
    pub issued_supply: String,
    pub supply_mode: SupplyMode,
    pub policy_utxos: Vec<SpendableUtxo>,
    pub fee: String,
    pub required_confirmations: u32,
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
    pub deployment: DeploymentManifestV1,
    pub deployment_id: String,
    pub initial_policy: PolicySnapshotV1,
    pub initial_holder_address: DerivedHolderAddress,
    pub issuer_derivation_index: u32,
    pub holder_derivation_index: u32,
    pub required_confirmations: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitFundingRequest {
    pub network: DeploymentNetwork,
    pub policy_asset: String,
    pub source_utxos: Vec<SpendableUtxo>,
    pub fee: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitFundingOutput {
    pub vout: u32,
    pub amount: String,
    pub confidential_address: String,
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
    pub fee: String,
    pub outputs: Vec<SplitFundingOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReissuanceRequest {
    pub deployment: DeploymentManifestV1,
    pub current_policy: PolicySnapshotV1,
    pub verifier_utxo: SpendableUtxo,
    pub token_utxo: SpendableUtxo,
    pub fee_utxos: Vec<SpendableUtxo>,
    pub recipient_address: String,
    pub amount: String,
    pub fee: String,
    pub issuer_derivation_index: u32,
}
