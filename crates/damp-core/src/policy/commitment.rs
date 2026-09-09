use super::wire::CommitmentFields;
use super::{PolicyError, PolicyRoot, SetRoot, TreeDepth, hash};
use serde::{Deserialize, Serialize};

/// A root/count/depth tuple with a bounded count and a canonical empty root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "CommitmentFields", into = "CommitmentFields")]
pub struct SetCommitment {
    root: SetRoot,
    count: u32,
    depth: TreeDepth,
}

impl SetCommitment {
    pub fn new(depth: TreeDepth, root: SetRoot, count: u32) -> Result<Self, PolicyError> {
        if count > depth.capacity() as u32 {
            return Err(PolicyError::Capacity(depth));
        }
        if count == 0
            && root.to_byte_array()
                != hash::empty_hashes(depth)[usize::from(depth.as_u8())].to_byte_array()
        {
            return Err(PolicyError::EmptyRoot);
        }
        Ok(Self { root, count, depth })
    }
    pub const fn root(self) -> SetRoot {
        self.root
    }
    pub const fn count(self) -> u32 {
        self.count
    }
    pub const fn depth(self) -> TreeDepth {
        self.depth
    }
    pub fn policy_digest(self) -> PolicyRoot {
        hash::policy_digest(self.depth, self.root, self.count)
    }
}
impl TryFrom<CommitmentFields> for SetCommitment {
    type Error = PolicyError;
    fn try_from(value: CommitmentFields) -> Result<Self, Self::Error> {
        Self::new(value.depth, value.root, value.count)
    }
}
impl From<SetCommitment> for CommitmentFields {
    fn from(value: SetCommitment) -> Self {
        Self {
            root: value.root,
            count: value.count,
            depth: value.depth,
        }
    }
}
