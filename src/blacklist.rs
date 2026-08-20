//! Blacklist-only application facade.

use simplex::simplicityhl::elements::OutPoint;

use crate::policy::{IndexedInputPolicyProof, PolicySet, SetCommitment, TreeDepth, outpoint_key};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlacklistPolicy {
    tree: PolicySet,
}

impl BlacklistPolicy {
    pub fn new(
        depth: TreeDepth,
        outpoints: impl IntoIterator<Item = OutPoint>,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            tree: PolicySet::new(depth, outpoints.into_iter().map(outpoint_key))?,
        })
    }

    pub fn empty(depth: TreeDepth) -> anyhow::Result<Self> {
        Self::new(depth, [])
    }

    #[must_use]
    pub fn commitment(&self) -> SetCommitment {
        self.tree.commitment()
    }

    pub fn prove_input(
        &self,
        input_index: u32,
        outpoint: OutPoint,
    ) -> anyhow::Result<IndexedInputPolicyProof> {
        anyhow::ensure!(
            input_index > 0,
            "regulated inputs must follow verifier input 0"
        );
        Ok(IndexedInputPolicyProof::new(
            input_index,
            self.tree.non_membership_proof(outpoint_key(outpoint))?,
        ))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tree.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tree.is_empty()
    }
}
