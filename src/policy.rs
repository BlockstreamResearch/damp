//! Elements adapters for the shared blacklist implementation.

use simplex::simplicityhl::elements::OutPoint;
use simplex::simplicityhl::elements::hashes::Hash;

pub use amp_core::policy::{
    Hash32, NeighborProof, NonMembershipProof, PolicySet, SetCommitment, TreeDepth, policy_digest,
    verify_non_membership,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedInputPolicyProof {
    pub input_index: u32,
    pub proof: NonMembershipProof,
}

impl IndexedInputPolicyProof {
    #[must_use]
    pub const fn new(input_index: u32, proof: NonMembershipProof) -> Self {
        Self { input_index, proof }
    }
}

/// Convert an Elements outpoint to the byte order seen by the Simplicity jet.
#[must_use]
pub fn outpoint_key(outpoint: OutPoint) -> Hash32 {
    amp_core::policy::outpoint_key_bytes(outpoint.txid.to_byte_array(), outpoint.vout)
}

pub fn policy_set_from_outpoints(
    depth: TreeDepth,
    outpoints: impl IntoIterator<Item = OutPoint>,
) -> anyhow::Result<PolicySet> {
    PolicySet::new(depth, outpoints.into_iter().map(outpoint_key))
}
