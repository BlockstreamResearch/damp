use super::wire::{NeighborFields, NonMembershipFields};
use super::{MerkleHash, PolicyError, PolicyKey, SetCommitment, hash};
use serde::Serialize;

/// A neighbor whose position and Merkle path were verified against its policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighborProof {
    index: u32,
    key: PolicyKey,
    path: Vec<MerkleHash>,
}
impl NeighborProof {
    pub const fn index(&self) -> u32 {
        self.index
    }
    pub const fn key(&self) -> PolicyKey {
        self.key
    }
    pub fn path(&self) -> &[MerkleHash] {
        &self.path
    }
}

/// A non-membership proof verified for one policy commitment and outpoint key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NonMembershipProof {
    insertion_index: u32,
    lower: Option<NeighborProof>,
    upper: Option<NeighborProof>,
    #[serde(skip)]
    commitment: SetCommitment,
    #[serde(skip)]
    key: PolicyKey,
}
impl NonMembershipProof {
    pub fn verify(
        commitment: SetCommitment,
        key: PolicyKey,
        fields: NonMembershipFields,
    ) -> Result<Self, PolicyError> {
        if fields.insertion_index > commitment.count() {
            return Err(PolicyError::InsertionIndex);
        }
        let lower = match fields.lower {
            None => {
                if fields.insertion_index != 0 {
                    return Err(PolicyError::MissingLower);
                }
                None
            }
            Some(lower) => {
                let lower = verify_neighbor(commitment, lower)?;
                if lower.key >= key {
                    return Err(PolicyError::LowerOrder);
                }
                if lower.index.checked_add(1) != Some(fields.insertion_index) {
                    return Err(PolicyError::LowerAdjacency);
                }
                Some(lower)
            }
        };
        let upper = match fields.upper {
            None => {
                if fields.insertion_index != commitment.count() {
                    return Err(PolicyError::MissingUpper);
                }
                None
            }
            Some(upper) => {
                if upper.index != fields.insertion_index {
                    return Err(PolicyError::UpperIndex);
                }
                let upper = verify_neighbor(commitment, upper)?;
                if key >= upper.key {
                    return Err(PolicyError::UpperOrder);
                }
                Some(upper)
            }
        };
        Ok(Self {
            insertion_index: fields.insertion_index,
            lower,
            upper,
            commitment,
            key,
        })
    }
    pub const fn insertion_index(&self) -> u32 {
        self.insertion_index
    }
    pub fn lower(&self) -> Option<&NeighborProof> {
        self.lower.as_ref()
    }
    pub fn upper(&self) -> Option<&NeighborProof> {
        self.upper.as_ref()
    }
    pub fn check_scope(
        &self,
        commitment: SetCommitment,
        key: PolicyKey,
    ) -> Result<(), PolicyError> {
        self.check_policy(commitment)?;
        if self.key == key {
            Ok(())
        } else {
            Err(PolicyError::ProofScope)
        }
    }

    pub fn check_policy(&self, commitment: SetCommitment) -> Result<(), PolicyError> {
        if self.commitment == commitment {
            Ok(())
        } else {
            Err(PolicyError::ProofScope)
        }
    }
}

fn verify_neighbor(
    commitment: SetCommitment,
    fields: NeighborFields,
) -> Result<NeighborProof, PolicyError> {
    if fields.index >= commitment.count() {
        return Err(PolicyError::NeighborIndex);
    }
    if fields.path.len() != usize::from(commitment.depth().as_u8()) {
        return Err(PolicyError::PathLength);
    }
    let mut current = hash::hash_key_leaf(fields.key);
    let mut index = fields.index;
    for sibling in &fields.path {
        current = if index & 1 == 0 {
            hash::hash_node(current, *sibling)
        } else {
            hash::hash_node(*sibling, current)
        };
        index >>= 1;
    }
    if index != 0 {
        return Err(PolicyError::PathIndex);
    }
    if current.to_byte_array() != commitment.root().to_byte_array() {
        return Err(PolicyError::ProofRoot);
    }
    Ok(NeighborProof {
        index: fields.index,
        key: fields.key,
        path: fields.path,
    })
}

/// Bind a verified policy proof to a transaction input; execution checks the input index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedInputPolicyProof {
    input_index: u32,
    proof: NonMembershipProof,
}
impl IndexedInputPolicyProof {
    pub const fn new(input_index: u32, proof: NonMembershipProof) -> Self {
        Self { input_index, proof }
    }
    pub const fn input_index(&self) -> u32 {
        self.input_index
    }
    pub const fn proof(&self) -> &NonMembershipProof {
        &self.proof
    }
}
