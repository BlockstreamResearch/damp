//! Consensus-adjacent, platform-independent AMP policy and registry logic.

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
