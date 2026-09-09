use damp_core::ledger::Outpoint;
use damp_core::policy::{NonMembershipProof, PolicySet, TreeDepth};
use damp_core::registry::{BlacklistEntry, PolicyRoot, SetRoot};
use serde::Serialize;

use crate::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltBlacklist {
    pub tree_depth: TreeDepth,
    pub policy_root: PolicyRoot,
    pub set_root: SetRoot,
    pub entry_count: u32,
    pub entries: Vec<BlacklistEntry>,
}

pub fn build_blacklist(
    depth: TreeDepth,
    mut entries: Vec<BlacklistEntry>,
) -> Result<BuiltBlacklist, Error> {
    entries.sort_by_key(BlacklistEntry::outpoint);
    let tree =
        PolicySet::new(depth, entries.iter().map(BlacklistEntry::key)).map_err(Error::Policy)?;
    let commitment = tree.commitment();
    Ok(BuiltBlacklist {
        tree_depth: depth,
        policy_root: commitment.policy_digest(),
        set_root: commitment.root(),
        entry_count: commitment.count(),
        entries,
    })
}

pub fn prove_non_membership(
    depth: TreeDepth,
    entries: &[BlacklistEntry],
    outpoint: Outpoint,
) -> Result<NonMembershipProof, Error> {
    let tree =
        PolicySet::new(depth, entries.iter().map(BlacklistEntry::key)).map_err(Error::Policy)?;
    let key = damp_core::policy::PolicyKey::for_outpoint(outpoint);
    tree.non_membership_proof(key).map_err(Error::Policy)
}
