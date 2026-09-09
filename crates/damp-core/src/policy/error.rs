use super::TreeDepth;

/// Policy construction or proof verification failed before covenant execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum PolicyError {
    #[error("unsupported tree depth {0}")]
    Depth(u8),
    #[error("blacklist exceeds capacity of 64 entries")]
    MaximumCapacity,
    #[error("blacklist exceeds capacity for depth {0:?}")]
    Capacity(TreeDepth),
    #[error("blacklist contains a duplicate exact outpoint")]
    Duplicate,
    #[error("outpoint is blacklisted")]
    Blacklisted,
    #[error("empty blacklist root mismatch")]
    EmptyRoot,
    #[error("insertion index exceeds blacklist count")]
    InsertionIndex,
    #[error("missing lower boundary")]
    MissingLower,
    #[error("missing upper boundary")]
    MissingUpper,
    #[error("lower key is not below target")]
    LowerOrder,
    #[error("upper key is not above target")]
    UpperOrder,
    #[error("lower neighbor is not adjacent")]
    LowerAdjacency,
    #[error("upper index mismatch")]
    UpperIndex,
    #[error("neighbor index out of range")]
    NeighborIndex,
    #[error("proof path length does not match tree depth")]
    PathLength,
    #[error("proof index exceeds tree depth")]
    PathIndex,
    #[error("proof root mismatch")]
    ProofRoot,
    #[error("proof belongs to another policy commitment or outpoint key")]
    ProofScope,
}
