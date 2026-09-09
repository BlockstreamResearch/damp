use super::TreeDepth;
use crate::{
    encoding::hex_value,
    ledger::{ConsensusTxid, Outpoint},
};
use sha2::{Digest, Sha256};

hex_value!(
    PolicyKey,
    "outpoint key",
    "SHA-256 key of one consensus transaction outpoint."
);
hex_value!(
    MerkleHash,
    "Merkle hash",
    "Hash of an internal policy-tree node or leaf."
);
hex_value!(
    SetRoot,
    "set root",
    "Merkle root of a sorted exact-output policy set."
);
hex_value!(
    PolicyRoot,
    "policy root",
    "Digest binding a policy set root, count and depth."
);

impl PolicyKey {
    pub fn for_outpoint(outpoint: Outpoint) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(ConsensusTxid::from(outpoint.txid()).to_byte_array());
        hasher.update(outpoint.vout().to_be_bytes());
        Self::from(<[u8; 32]>::from(hasher.finalize()))
    }
}

const POLICY_DIGEST_DOMAIN: &[u8] = b"simplicity-damp/policy-digest/v1";
const POLICY_DIGEST_LABEL: &[u8] = b"simplicity-damp/v0.1";

pub(super) fn policy_digest(depth: TreeDepth, root: SetRoot, count: u32) -> PolicyRoot {
    let mut hasher = Sha256::new();
    hasher.update(POLICY_DIGEST_DOMAIN);
    hasher.update((POLICY_DIGEST_LABEL.len() as u32).to_be_bytes());
    hasher.update(POLICY_DIGEST_LABEL);
    hasher.update([depth.as_u8()]);
    hasher.update(root.as_ref());
    hasher.update(count.to_be_bytes());
    PolicyRoot::from(<[u8; 32]>::from(hasher.finalize()))
}

pub(super) fn empty_hashes(depth: TreeDepth) -> Vec<MerkleHash> {
    let mut hashes = Vec::with_capacity(usize::from(depth.as_u8()) + 1);
    hashes.push(MerkleHash::from(<[u8; 32]>::from(Sha256::digest([1]))));
    for level in 0..usize::from(depth.as_u8()) {
        hashes.push(hash_node(hashes[level], hashes[level]));
    }
    hashes
}
pub(super) fn hash_key_leaf(key: PolicyKey) -> MerkleHash {
    let mut hasher = Sha256::new();
    hasher.update([0]);
    hasher.update(key.as_ref());
    MerkleHash::from(<[u8; 32]>::from(hasher.finalize()))
}
pub(super) fn hash_node(left: MerkleHash, right: MerkleHash) -> MerkleHash {
    let mut hasher = Sha256::new();
    hasher.update([2]);
    hasher.update(left.as_ref());
    hasher.update(right.as_ref());
    MerkleHash::from(<[u8; 32]>::from(hasher.finalize()))
}
