//! Consensus-adjacent, platform-independent AMP policy and registry logic.

/// SHA-256 of the exact bundled v0.1 Simplicity contract sources and generated artifacts.
pub const CONTRACT_BUNDLE_HASH: &str =
    "00a50b7658d5914170286b75b95200687b7773c7082c02e3da1dd20012401b74";

/// Versioned native audit source and generated program bundle.
pub const CONTRACT_BUNDLE_V2_HASH: &str =
    "8697c7b919b0ce8bb2a52e3165931c2ca1fc284f4d9aee1b18c9be777763c2f8";

pub mod native_audit;
pub mod pgc_policy;
pub mod policy;
pub mod registry;

pub use policy::{
    Hash32, NeighborProof, NonMembershipProof, Outpoint, PolicySet, SetCommitment, TreeDepth,
    outpoint_key, outpoint_key_bytes, policy_digest,
};
pub use registry::{
    AssetMetadata, BlacklistEntryV1, DeploymentManifestV1, DeploymentNetwork, PolicySnapshotV1,
    SupplyMode,
};
