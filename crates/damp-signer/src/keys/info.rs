use crate::keys::KeyIndex;
use crate::network::DeploymentNetwork;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedHolderAddress {
    pub sdk: &'static str,
    pub derivation_index: KeyIndex,
    pub owner_public_key: String,
    pub script_pubkey: String,
    pub confidential_address: super::ConfidentialAddress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedDampKey {
    pub sdk: &'static str,
    pub derivation_index: KeyIndex,
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
    pub confidential_address: super::ConfidentialAddress,
    pub script_pubkey: String,
}

/// Wallet metadata. The descriptor includes private blinding material.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerInfo {
    pub sdk: &'static str,
    pub fingerprint: String,
    pub descriptor: String,
    pub network: DeploymentNetwork,
}

impl std::fmt::Debug for SignerInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignerInfo")
            .field("sdk", &self.sdk)
            .field("fingerprint", &self.fingerprint)
            .field("descriptor", &"[REDACTED]")
            .field("network", &self.network)
            .finish()
    }
}
