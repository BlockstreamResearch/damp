use crate::{Error, Result};
use damp_core::registry::DeploymentNetwork;
use elements::BlockHash;
use serde::{Deserialize, Serialize};

/// Public identities only. Provider identifiers must exclude authentication data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ScopeWire", into = "ScopeWire")]
pub struct Scope(ScopeWire);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopeWire {
    deployment_id: String,
    network: DeploymentNetwork,
    genesis: BlockHash,
    provider: String,
    decoder: String,
}

impl Scope {
    pub fn new(
        deployment_id: String,
        network: DeploymentNetwork,
        genesis: BlockHash,
        provider: String,
        decoder: String,
    ) -> Result<Self> {
        ScopeWire {
            deployment_id,
            network,
            genesis,
            provider,
            decoder,
        }
        .try_into()
    }
    pub fn deployment_id(&self) -> &str {
        &self.0.deployment_id
    }
    pub fn network(&self) -> DeploymentNetwork {
        self.0.network
    }
    pub fn genesis(&self) -> BlockHash {
        self.0.genesis
    }
    pub fn provider(&self) -> &str {
        &self.0.provider
    }
    pub fn decoder(&self) -> &str {
        &self.0.decoder
    }
}
impl TryFrom<ScopeWire> for Scope {
    type Error = Error;
    fn try_from(value: ScopeWire) -> Result<Self> {
        if [&value.deployment_id, &value.provider, &value.decoder]
            .iter()
            .any(|s| s.is_empty() || s.len() > 512 || s.chars().any(char::is_control))
            || value.provider.contains(['@', '?', '#'])
        {
            return Err(Error::Scope);
        }
        Ok(Self(value))
    }
}
impl From<Scope> for ScopeWire {
    fn from(value: Scope) -> Self {
        value.0
    }
}

/// A pinned range. Deserialization also enforces its height ordering.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "SnapshotWire", into = "SnapshotWire")]
pub struct Snapshot(SnapshotWire);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotWire {
    start_height: u32,
    start_hash: BlockHash,
    through_height: u32,
    through_hash: BlockHash,
    tip_height: u32,
    tip_hash: BlockHash,
}

impl Snapshot {
    pub fn new(
        start: (u32, BlockHash),
        through: (u32, BlockHash),
        tip: (u32, BlockHash),
    ) -> Result<Self> {
        SnapshotWire {
            start_height: start.0,
            start_hash: start.1,
            through_height: through.0,
            through_hash: through.1,
            tip_height: tip.0,
            tip_hash: tip.1,
        }
        .try_into()
    }
    pub fn start(&self) -> u32 {
        self.0.start_height
    }
    pub fn through(&self) -> u32 {
        self.0.through_height
    }
    pub fn tip(&self) -> u32 {
        self.0.tip_height
    }
    pub fn start_hash(&self) -> BlockHash {
        self.0.start_hash
    }
    pub fn through_hash(&self) -> BlockHash {
        self.0.through_hash
    }
    pub fn tip_hash(&self) -> BlockHash {
        self.0.tip_hash
    }
}
impl TryFrom<SnapshotWire> for Snapshot {
    type Error = Error;
    fn try_from(value: SnapshotWire) -> Result<Self> {
        if value.start_height > value.through_height
            || value.through_height > value.tip_height
            || (value.start_height == value.through_height
                && value.start_hash != value.through_hash)
            || (value.through_height == value.tip_height && value.through_hash != value.tip_hash)
        {
            return Err(Error::Integrity("invalid snapshot range"));
        }
        Ok(Self(value))
    }
}
impl From<Snapshot> for SnapshotWire {
    fn from(value: Snapshot) -> Self {
        value.0
    }
}
