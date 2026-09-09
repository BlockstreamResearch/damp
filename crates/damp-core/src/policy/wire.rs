//! Untrusted proof fields require statement-dependent verification before use.
use super::{MerkleHash, PolicyKey, SetRoot, TreeDepth};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitmentFields {
    pub root: SetRoot,
    pub count: u32,
    pub depth: TreeDepth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeighborFields {
    pub index: u32,
    pub key: PolicyKey,
    pub path: Vec<MerkleHash>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NonMembershipFields {
    pub insertion_index: u32,
    #[serde(deserialize_with = "required_nullable")]
    pub lower: Option<NeighborFields>,
    #[serde(deserialize_with = "required_nullable")]
    pub upper: Option<NeighborFields>,
}

fn required_nullable<'de, D, T>(decoder: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(decoder)
}
