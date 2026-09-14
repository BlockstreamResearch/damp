use crate::BlockHash;
use damp_signer::transaction::PublicTransaction;
use serde::{Deserialize, Serialize};

/// Native public transaction fields and their indexed block location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedTransaction {
    pub(crate) height: u32,
    pub(crate) block_hash: BlockHash,
    #[serde(flatten)]
    pub(crate) transaction: PublicTransaction,
}
impl IndexedTransaction {
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn block_hash(&self) -> BlockHash {
        self.block_hash
    }
    pub fn transaction(&self) -> &PublicTransaction {
        &self.transaction
    }
}
