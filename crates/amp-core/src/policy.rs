//! Canonical sorted blacklist trees and non-membership proofs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const POLICY_DOMAIN_V1: &[u8] = b"simplicity-amp/policy-digest/v1";
pub const POLICY_PROTOCOL_ID_V1: &[u8] = b"simplicity-amp/v0.1";
pub const SUPPORTED_DEPTHS: [TreeDepth; 3] = [TreeDepth::D4, TreeDepth::D5, TreeDepth::D6];
pub type Hash32 = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TreeDepth {
    D4,
    D5,
    D6,
}

impl TreeDepth {
    #[must_use]
    pub const fn as_u8(self) -> u8 {
        match self {
            Self::D4 => 4,
            Self::D5 => 5,
            Self::D6 => 6,
        }
    }

    #[must_use]
    pub const fn capacity(self) -> usize {
        1 << self.as_u8()
    }

    pub fn smallest_for_len(len: usize) -> anyhow::Result<Self> {
        SUPPORTED_DEPTHS
            .into_iter()
            .find(|depth| len <= depth.capacity())
            .ok_or_else(|| anyhow::anyhow!("blacklist exceeds v0.1 capacity of 64 entries"))
    }
}

impl TryFrom<u8> for TreeDepth {
    type Error = anyhow::Error;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            4 => Ok(Self::D4),
            5 => Ok(Self::D5),
            6 => Ok(Self::D6),
            _ => anyhow::bail!("unsupported v0.1 tree depth {value}"),
        }
    }
}

impl From<TreeDepth> for u8 {
    fn from(value: TreeDepth) -> Self {
        value.as_u8()
    }
}

impl Serialize for TreeDepth {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_u8(self.as_u8())
    }
}

impl<'de> Deserialize<'de> for TreeDepth {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::try_from(u8::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outpoint {
    pub txid: Hash32,
    pub vout: u32,
}

impl Outpoint {
    pub fn from_display(txid: &str, vout: u32) -> anyhow::Result<Self> {
        let mut consensus_txid = decode_hex_32("transaction id", txid)?;
        consensus_txid.reverse();
        Ok(Self {
            txid: consensus_txid,
            vout,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCommitment {
    pub root: Hash32,
    pub count: u32,
    pub depth: TreeDepth,
}

impl SetCommitment {
    #[must_use]
    pub fn policy_digest(self) -> Hash32 {
        policy_digest(self.depth, self.root, self.count)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeighborProof {
    pub index: u32,
    pub key: Hash32,
    pub path: Vec<Hash32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NonMembershipProof {
    pub insertion_index: u32,
    pub lower: Option<NeighborProof>,
    pub upper: Option<NeighborProof>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicySet {
    depth: TreeDepth,
    keys: Vec<Hash32>,
    levels: Vec<BTreeMap<u32, Hash32>>,
    empty_hashes: Vec<Hash32>,
}

impl PolicySet {
    pub fn new(depth: TreeDepth, keys: impl IntoIterator<Item = Hash32>) -> anyhow::Result<Self> {
        let mut keys: Vec<_> = keys.into_iter().collect();
        keys.sort_unstable();
        anyhow::ensure!(
            keys.len() <= depth.capacity(),
            "depth {} blacklist exceeds {} entries",
            depth.as_u8(),
            depth.capacity()
        );
        anyhow::ensure!(
            keys.windows(2).all(|pair| pair[0] != pair[1]),
            "blacklist contains a duplicate exact outpoint"
        );

        let empty_hashes = empty_hashes(depth);
        let mut levels = Vec::with_capacity(usize::from(depth.as_u8()) + 1);
        let mut leaves = BTreeMap::new();
        for (index, key) in keys.iter().enumerate() {
            leaves.insert(u32::try_from(index)?, hash_key_leaf(*key));
        }
        levels.push(leaves);

        for level in 0..usize::from(depth.as_u8()) {
            let current = &levels[level];
            let mut parents = BTreeMap::new();
            for child_index in current.keys() {
                let parent_index = child_index >> 1;
                if parents.contains_key(&parent_index) {
                    continue;
                }
                let left = current
                    .get(&(parent_index << 1))
                    .copied()
                    .unwrap_or(empty_hashes[level]);
                let right = current
                    .get(&((parent_index << 1) | 1))
                    .copied()
                    .unwrap_or(empty_hashes[level]);
                parents.insert(parent_index, hash_node(left, right));
            }
            levels.push(parents);
        }

        Ok(Self {
            depth,
            keys,
            levels,
            empty_hashes,
        })
    }

    pub fn from_display_outpoints(
        depth: TreeDepth,
        outpoints: impl IntoIterator<Item = (String, u32)>,
    ) -> anyhow::Result<Self> {
        let keys = outpoints
            .into_iter()
            .map(|(txid, vout)| outpoint_key(&txid, vout))
            .collect::<anyhow::Result<Vec<_>>>()?;
        Self::new(depth, keys)
    }

    #[must_use]
    pub const fn depth(&self) -> TreeDepth {
        self.depth
    }

    #[must_use]
    pub fn root(&self) -> Hash32 {
        self.levels[usize::from(self.depth.as_u8())]
            .get(&0)
            .copied()
            .unwrap_or(self.empty_hashes[usize::from(self.depth.as_u8())])
    }

    #[must_use]
    pub fn commitment(&self) -> SetCommitment {
        SetCommitment {
            root: self.root(),
            count: self.keys.len() as u32,
            depth: self.depth,
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn non_membership_proof(&self, key: Hash32) -> anyhow::Result<NonMembershipProof> {
        let insertion_index = self
            .keys
            .binary_search(&key)
            .map_or_else(Ok, |_| anyhow::bail!("outpoint is blacklisted"))?;
        let lower = insertion_index
            .checked_sub(1)
            .map(|index| self.neighbor(index));
        let upper = (insertion_index < self.keys.len()).then(|| self.neighbor(insertion_index));
        Ok(NonMembershipProof {
            insertion_index: u32::try_from(insertion_index)?,
            lower,
            upper,
        })
    }

    pub fn verify_non_membership(
        &self,
        key: Hash32,
        proof: &NonMembershipProof,
    ) -> anyhow::Result<()> {
        verify_non_membership(self.commitment(), key, proof)
    }

    fn neighbor(&self, index: usize) -> NeighborProof {
        NeighborProof {
            index: index as u32,
            key: self.keys[index],
            path: self.path(index as u32),
        }
    }

    fn path(&self, mut index: u32) -> Vec<Hash32> {
        let mut path = Vec::with_capacity(usize::from(self.depth.as_u8()));
        for level in 0..usize::from(self.depth.as_u8()) {
            path.push(
                self.levels[level]
                    .get(&(index ^ 1))
                    .copied()
                    .unwrap_or(self.empty_hashes[level]),
            );
            index >>= 1;
        }
        path
    }
}

pub fn verify_non_membership(
    commitment: SetCommitment,
    key: Hash32,
    proof: &NonMembershipProof,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        usize::try_from(commitment.count)? <= commitment.depth.capacity(),
        "blacklist count exceeds tree capacity"
    );
    anyhow::ensure!(
        proof.insertion_index <= commitment.count,
        "insertion index exceeds blacklist count"
    );
    match &proof.lower {
        None => anyhow::ensure!(proof.insertion_index == 0, "missing lower boundary"),
        Some(lower) => {
            verify_neighbor(commitment, lower)?;
            anyhow::ensure!(lower.key < key, "lower key is not below target");
            anyhow::ensure!(
                lower.index.checked_add(1) == Some(proof.insertion_index),
                "lower neighbor is not adjacent"
            );
        }
    }
    match &proof.upper {
        None => anyhow::ensure!(
            proof.insertion_index == commitment.count,
            "missing upper boundary"
        ),
        Some(upper) => {
            anyhow::ensure!(upper.index == proof.insertion_index, "upper index mismatch");
            verify_neighbor(commitment, upper)?;
            anyhow::ensure!(key < upper.key, "upper key is not above target");
        }
    }
    if commitment.count == 0 {
        anyhow::ensure!(
            commitment.root
                == empty_hashes(commitment.depth)[usize::from(commitment.depth.as_u8())],
            "empty blacklist root mismatch"
        );
    }
    Ok(())
}

fn verify_neighbor(commitment: SetCommitment, proof: &NeighborProof) -> anyhow::Result<()> {
    anyhow::ensure!(
        proof.index < commitment.count,
        "neighbor index out of range"
    );
    anyhow::ensure!(
        proof.path.len() == usize::from(commitment.depth.as_u8()),
        "proof path length does not match tree depth"
    );
    let mut current = hash_key_leaf(proof.key);
    let mut index = proof.index;
    for sibling in &proof.path {
        current = if index & 1 == 0 {
            hash_node(current, *sibling)
        } else {
            hash_node(*sibling, current)
        };
        index >>= 1;
    }
    anyhow::ensure!(index == 0, "proof index exceeds tree depth");
    anyhow::ensure!(current == commitment.root, "proof root mismatch");
    Ok(())
}

pub fn outpoint_key(txid: &str, vout: u32) -> anyhow::Result<Hash32> {
    Ok(outpoint_key_bytes(
        Outpoint::from_display(txid, vout)?.txid,
        vout,
    ))
}

#[must_use]
pub fn outpoint_key_bytes(consensus_txid: Hash32, vout: u32) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update(consensus_txid);
    hasher.update(vout.to_be_bytes());
    hasher.finalize().into()
}

#[must_use]
pub fn policy_digest(depth: TreeDepth, root: Hash32, count: u32) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update(POLICY_DOMAIN_V1);
    hasher.update((POLICY_PROTOCOL_ID_V1.len() as u32).to_be_bytes());
    hasher.update(POLICY_PROTOCOL_ID_V1);
    hasher.update([depth.as_u8()]);
    hasher.update(root);
    hasher.update(count.to_be_bytes());
    hasher.finalize().into()
}

pub fn decode_hex_32(name: &str, value: &str) -> anyhow::Result<Hash32> {
    anyhow::ensure!(value.len() == 64, "{name} must be 32-byte lowercase hex");
    anyhow::ensure!(
        value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "{name} must be lowercase hex"
    );
    hex::decode(value)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("{name} must be 32 bytes"))
}

fn empty_hashes(depth: TreeDepth) -> Vec<Hash32> {
    let mut hashes = Vec::with_capacity(usize::from(depth.as_u8()) + 1);
    hashes.push(Sha256::digest([1]).into());
    for level in 0..usize::from(depth.as_u8()) {
        hashes.push(hash_node(hashes[level], hashes[level]));
    }
    hashes
}

fn hash_key_leaf(key: Hash32) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update([0]);
    hasher.update(key);
    hasher.finalize().into()
}

fn hash_node(left: Hash32, right: Hash32) -> Hash32 {
    let mut hasher = Sha256::new();
    hasher.update([2]);
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_roots_match_contract_constants() -> anyhow::Result<()> {
        assert_eq!(
            hex::encode(PolicySet::new(TreeDepth::D4, [])?.root()),
            "36c614d3fcffdbdfe4baf66656fb17c8373bd42eb8aca046ec5b50ae8395f0cf"
        );
        assert_eq!(
            hex::encode(PolicySet::new(TreeDepth::D5, [])?.root()),
            "90b3ab21a9f9e4d9a952ec812e65e997fff5f1f39ebcbf85d04bf191d9da30b5"
        );
        assert_eq!(
            hex::encode(PolicySet::new(TreeDepth::D6, [])?.root()),
            "7ccebc8f78646b5eece300cb6cfc0dce0fb94f4ddb1f7c0edc4d9eb30851aa0a"
        );
        Ok(())
    }

    #[test]
    fn every_depth_proves_boundaries_and_interior() -> anyhow::Result<()> {
        for depth in SUPPORTED_DEPTHS {
            let set = PolicySet::new(depth, [[0x20; 32], [0x40; 32], [0x60; 32]])?;
            for key in [[0x10; 32], [0x50; 32], [0x70; 32]] {
                let proof = set.non_membership_proof(key)?;
                set.verify_non_membership(key, &proof)?;
                assert_eq!(
                    proof.lower.as_ref().map(|p| p.path.len()).unwrap_or(0),
                    if proof.lower.is_some() {
                        usize::from(depth.as_u8())
                    } else {
                        0
                    }
                );
            }
            assert!(set.non_membership_proof([0x40; 32]).is_err());
        }
        Ok(())
    }

    #[test]
    fn capacity_and_duplicate_rules_are_exact() -> anyhow::Result<()> {
        for depth in SUPPORTED_DEPTHS {
            let key = |index: usize| {
                let mut key = [0; 32];
                key[24..].copy_from_slice(&(index as u64).to_be_bytes());
                key
            };
            assert_eq!(
                PolicySet::new(depth, (0..depth.capacity()).map(key))?.len(),
                depth.capacity()
            );
            assert!(PolicySet::new(depth, (0..=depth.capacity()).map(key)).is_err());
        }
        assert!(PolicySet::new(TreeDepth::D4, [[1; 32], [1; 32]]).is_err());
        Ok(())
    }

    #[test]
    fn malformed_paths_indexes_and_counts_are_rejected() -> anyhow::Result<()> {
        for depth in SUPPORTED_DEPTHS {
            let set = PolicySet::new(depth, [[0x20; 32], [0x40; 32]])?;
            let target = [0x30; 32];
            let proof = set.non_membership_proof(target)?;

            let mut wrong_path = proof.clone();
            wrong_path
                .lower
                .as_mut()
                .expect("interior proof")
                .path
                .pop();
            assert!(set.verify_non_membership(target, &wrong_path).is_err());

            let mut wrong_index = proof.clone();
            wrong_index.upper.as_mut().expect("interior proof").index += 1;
            assert!(set.verify_non_membership(target, &wrong_index).is_err());

            let overflow = SetCommitment {
                count: u32::try_from(depth.capacity() + 1)?,
                ..set.commitment()
            };
            assert!(verify_non_membership(overflow, target, &proof).is_err());
        }
        Ok(())
    }

    #[test]
    fn display_txid_is_normalized_to_consensus_order() -> anyhow::Result<()> {
        let display = format!("01{}", "00".repeat(31));
        let mut consensus = [0; 32];
        consensus[31] = 1;
        assert_eq!(outpoint_key(&display, 7)?, outpoint_key_bytes(consensus, 7));
        Ok(())
    }

    #[test]
    fn rust_matches_shared_wasm_policy_vectors() -> anyhow::Result<()> {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/policy-vectors.json"))?;
        for vector in vectors.as_array().expect("vector array") {
            let depth = TreeDepth::try_from(vector["treeDepth"].as_u64().expect("depth") as u8)?;
            let commitment = PolicySet::new(depth, [])?.commitment();
            assert_eq!(
                hex::encode(commitment.root),
                vector["setRoot"].as_str().expect("root")
            );
            assert_eq!(
                hex::encode(commitment.policy_digest()),
                vector["policyRoot"].as_str().expect("digest")
            );
            assert_eq!(
                u64::from(commitment.count),
                vector["entryCount"].as_u64().expect("count")
            );
        }
        Ok(())
    }
}
