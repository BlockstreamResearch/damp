use super::hash::{empty_hashes, hash_key_leaf, hash_node};
use super::wire::{NeighborFields, NonMembershipFields};
use super::{
    MerkleHash, NonMembershipProof, PolicyError, PolicyKey, SetCommitment, SetRoot, TreeDepth,
};
use crate::ledger::Outpoint;
use std::collections::BTreeMap;

/// A sorted, duplicate-free set bounded by one supported tree capacity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicySet {
    commitment: SetCommitment,
    keys: Vec<PolicyKey>,
    levels: Vec<BTreeMap<u32, MerkleHash>>,
    empty_hashes: Vec<MerkleHash>,
}

impl PolicySet {
    pub fn new(
        depth: TreeDepth,
        keys: impl IntoIterator<Item = PolicyKey>,
    ) -> Result<Self, PolicyError> {
        let mut keys: Vec<_> = keys.into_iter().take(depth.capacity() + 1).collect();
        if keys.len() > depth.capacity() {
            return Err(PolicyError::Capacity(depth));
        }
        keys.sort_unstable();
        if keys.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(PolicyError::Duplicate);
        }
        let empty_hashes = empty_hashes(depth);
        let mut levels = Vec::with_capacity(usize::from(depth.as_u8()) + 1);
        let leaves = keys
            .iter()
            .enumerate()
            .map(|(index, key)| (index as u32, hash_key_leaf(*key)))
            .collect::<BTreeMap<_, _>>();
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
        let height = usize::from(depth.as_u8());
        let root = levels[height]
            .get(&0)
            .copied()
            .unwrap_or(empty_hashes[height]);
        let commitment = SetCommitment::new(depth, root.to_byte_array().into(), keys.len() as u32)?;
        Ok(Self {
            commitment,
            keys,
            levels,
            empty_hashes,
        })
    }

    pub fn from_outpoints(
        depth: TreeDepth,
        outpoints: impl IntoIterator<Item = Outpoint>,
    ) -> Result<Self, PolicyError> {
        Self::new(depth, outpoints.into_iter().map(PolicyKey::for_outpoint))
    }
    pub const fn depth(&self) -> TreeDepth {
        self.commitment.depth()
    }
    pub const fn root(&self) -> SetRoot {
        self.commitment.root()
    }
    pub const fn commitment(&self) -> SetCommitment {
        self.commitment
    }
    pub fn len(&self) -> usize {
        self.keys.len()
    }
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn non_membership_proof(&self, key: PolicyKey) -> Result<NonMembershipProof, PolicyError> {
        let insertion_index = match self.keys.binary_search(&key) {
            Ok(_) => return Err(PolicyError::Blacklisted),
            Err(index) => index,
        };
        let fields = NonMembershipFields {
            insertion_index: insertion_index as u32,
            lower: insertion_index
                .checked_sub(1)
                .map(|index| self.neighbor(index)),
            upper: (insertion_index < self.keys.len()).then(|| self.neighbor(insertion_index)),
        };
        NonMembershipProof::verify(self.commitment, key, fields)
    }

    fn neighbor(&self, index: usize) -> NeighborFields {
        NeighborFields {
            index: index as u32,
            key: self.keys[index],
            path: self.path(index as u32),
        }
    }
    fn path(&self, mut index: u32) -> Vec<MerkleHash> {
        let mut path = Vec::with_capacity(usize::from(self.depth().as_u8()));
        for level in 0..usize::from(self.depth().as_u8()) {
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
