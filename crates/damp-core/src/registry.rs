//! Parsed deployment and policy records.
mod entry;
mod error;
mod identity;
mod manifest;
mod metadata;
mod snapshot;
mod supply;
pub mod wire;

pub use crate::policy::{PolicyRoot, SetRoot};
pub use entry::BlacklistEntry;
pub use error::RegistryError;
pub use identity::ScriptHash;
pub use identity::{BundleHash, DeploymentId, DeploymentSalt, IssuanceEntropy, ProgramHash};
pub use manifest::DeploymentManifest;
pub use metadata::{AssetMetadata, AuditEpoch, NativeAuditConfig};
pub use snapshot::PolicySnapshot;
pub use supply::{Supply, SupplyMode};

pub const REGISTRY_SCHEMA: &str = "simplicity-damp-registry-v1";
pub const PROTOCOL_ID: &str = "simplicity-damp/v0.2";

use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentNetwork {
    LiquidTestnet,
    ElementsRegtest,
}

impl DeploymentNetwork {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LiquidTestnet => "liquid-testnet",
            Self::ElementsRegtest => "elements-regtest",
        }
    }
}
