use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    BlacklistEntry, DeploymentId, PROTOCOL_ID, PolicyRoot, ProgramHash, REGISTRY_SCHEMA,
    RegistryError, ScriptHash, SetRoot, wire::SnapshotFields,
};
use crate::ledger::ScriptPubkey;
use crate::policy::{PolicySet, TreeDepth};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Parent {
    Genesis,
    Successor {
        sequence: u64,
        policy: PolicyRoot,
        script: ScriptHash,
    },
}

/// An immutable policy whose ordered entries reproduce its declared commitments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SnapshotFields", into = "SnapshotFields")]
pub struct PolicySnapshot {
    deployment_id: DeploymentId,
    parent: Parent,
    tree: PolicySet,
    verifier_program_hash: ProgramHash,
    verifier_script_pubkey: ScriptPubkey,
    entries: Vec<BlacklistEntry>,
}

impl TryFrom<SnapshotFields> for PolicySnapshot {
    type Error = RegistryError;
    fn try_from(value: SnapshotFields) -> Result<Self, Self::Error> {
        if value.schema != REGISTRY_SCHEMA {
            return Err(RegistryError::Schema);
        }
        if value.protocol != PROTOCOL_ID {
            return Err(RegistryError::Protocol);
        }
        let parent = match (
            value.sequence,
            value.parent_policy_root,
            value.parent_verifier_script_hash,
        ) {
            (0, None, None) => Parent::Genesis,
            (sequence, Some(policy), Some(script))
                if (1..=9_007_199_254_740_991).contains(&sequence) =>
            {
                Parent::Successor {
                    sequence,
                    policy,
                    script,
                }
            }
            _ => return Err(RegistryError::Parent),
        };
        if !value
            .entries
            .windows(2)
            .all(|pair| pair[0].outpoint() < pair[1].outpoint())
        {
            return Err(RegistryError::EntryOrder);
        }
        let tree = PolicySet::new(
            value.tree_depth,
            value.entries.iter().map(BlacklistEntry::key),
        )
        .map_err(RegistryError::Policy)?;
        let commitment = tree.commitment();
        if value.entry_count != commitment.count() {
            return Err(RegistryError::Commitment {
                field: "entry count",
            });
        }
        if value.set_root != commitment.root() {
            return Err(RegistryError::Commitment { field: "set root" });
        }
        if value.policy_root != commitment.policy_digest() {
            return Err(RegistryError::Commitment { field: "digest" });
        }
        Ok(Self {
            deployment_id: value.deployment_id,
            parent,
            tree,
            verifier_program_hash: value.verifier_program_hash,
            verifier_script_pubkey: value.verifier_script_pubkey,
            entries: value.entries,
        })
    }
}

impl PolicySnapshot {
    pub const fn deployment_id(&self) -> DeploymentId {
        self.deployment_id
    }
    pub const fn sequence(&self) -> u64 {
        match self.parent {
            Parent::Genesis => 0,
            Parent::Successor { sequence, .. } => sequence,
        }
    }
    pub const fn parent_policy_root(&self) -> Option<PolicyRoot> {
        match self.parent {
            Parent::Genesis => None,
            Parent::Successor { policy, .. } => Some(policy),
        }
    }
    pub const fn parent_verifier_script_hash(&self) -> Option<ScriptHash> {
        match self.parent {
            Parent::Genesis => None,
            Parent::Successor { script, .. } => Some(script),
        }
    }
    pub fn tree(&self) -> &PolicySet {
        &self.tree
    }
    pub fn tree_depth(&self) -> TreeDepth {
        self.tree.depth()
    }
    pub fn entry_count(&self) -> u32 {
        self.tree.commitment().count()
    }
    pub fn set_root(&self) -> SetRoot {
        self.tree.root()
    }
    pub fn policy_root(&self) -> PolicyRoot {
        self.tree.commitment().policy_digest()
    }
    pub const fn verifier_program_hash(&self) -> ProgramHash {
        self.verifier_program_hash
    }
    pub fn verifier_script_pubkey(&self) -> &ScriptPubkey {
        &self.verifier_script_pubkey
    }
    pub fn entries(&self) -> &[BlacklistEntry] {
        &self.entries
    }
    pub fn verifier_script_hash(&self) -> ScriptHash {
        <[u8; 32]>::from(Sha256::digest(self.verifier_script_pubkey.as_bytes())).into()
    }
    pub fn registry_path(&self) -> String {
        format!(
            "registry/policies/{}/{}.json",
            self.deployment_id,
            self.verifier_script_hash()
        )
    }
}

impl From<PolicySnapshot> for SnapshotFields {
    fn from(value: PolicySnapshot) -> Self {
        Self {
            schema: REGISTRY_SCHEMA.to_owned(),
            protocol: PROTOCOL_ID.to_owned(),
            deployment_id: value.deployment_id,
            sequence: value.sequence(),
            parent_policy_root: value.parent_policy_root(),
            parent_verifier_script_hash: value.parent_verifier_script_hash(),
            tree_depth: value.tree_depth(),
            set_root: value.set_root(),
            entry_count: value.entry_count(),
            policy_root: value.policy_root(),
            verifier_program_hash: value.verifier_program_hash,
            verifier_script_pubkey: value.verifier_script_pubkey,
            entries: value.entries,
        }
    }
}
