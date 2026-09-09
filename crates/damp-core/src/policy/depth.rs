use super::PolicyError;
use serde::{Deserialize, Serialize};

/// Merkle depths supported by the compiled verifier programs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub enum TreeDepth {
    D4,
    D5,
    D6,
}

pub const SUPPORTED_DEPTHS: [TreeDepth; 3] = [TreeDepth::D4, TreeDepth::D5, TreeDepth::D6];

impl TreeDepth {
    pub const fn as_u8(self) -> u8 {
        match self {
            Self::D4 => 4,
            Self::D5 => 5,
            Self::D6 => 6,
        }
    }
    pub const fn capacity(self) -> usize {
        1 << self.as_u8()
    }
    pub fn smallest_for_len(len: usize) -> Result<Self, PolicyError> {
        SUPPORTED_DEPTHS
            .into_iter()
            .find(|depth| len <= depth.capacity())
            .ok_or(PolicyError::MaximumCapacity)
    }
}
impl TryFrom<u8> for TreeDepth {
    type Error = PolicyError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            4 => Ok(Self::D4),
            5 => Ok(Self::D5),
            6 => Ok(Self::D6),
            value => Err(PolicyError::Depth(value)),
        }
    }
}
impl From<TreeDepth> for u8 {
    fn from(value: TreeDepth) -> Self {
        value.as_u8()
    }
}
