use damp_core::{
    ledger::{ConsensusTxid, Outpoint},
    native_audit::RecoveryBound,
    registry::{DeploymentManifest, PolicySnapshot},
};
use elements::{TxOut, hashes::Hash as _};
use serde::Deserialize;
use std::collections::BTreeMap;

use super::RecoveryError;
use crate::transaction::TransactionRecord;

/// Parsed recovery inputs with every spent output resolved to a supplied parent.
/// Parent identity checks do not establish chain inclusion or current spendability.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "RecoveryFields")]
pub struct RecoveryRequest {
    deployment: DeploymentManifest,
    policy: PolicySnapshot,
    transaction: TransactionRecord,
    spent_outputs: Vec<TxOut>,
    dlp_upper_bound: Option<RecoveryBound>,
}
impl RecoveryRequest {
    pub const MAX_TRANSACTION_BYTES: usize = 400_000;
    pub const MAX_PARENTS: usize = 256;

    /// Bind the transaction and all input outpoints to bounded parent data.
    ///
    /// # Errors
    /// Rejects a foreign policy, excessive data, duplicate parents, missing parents
    /// or an input index outside its identified parent's outputs.
    pub fn new(
        deployment: DeploymentManifest,
        policy: PolicySnapshot,
        transaction: TransactionRecord,
        parents: impl IntoIterator<Item = TransactionRecord>,
        dlp_upper_bound: Option<RecoveryBound>,
    ) -> Result<Self, RecoveryError> {
        if policy.deployment_id() != deployment.deployment_id() {
            return Err(RecoveryError::PolicyDeployment);
        }
        if transaction.encoded_size() > Self::MAX_TRANSACTION_BYTES {
            return Err(RecoveryError::TransactionSize);
        }
        let mut previous = BTreeMap::new();
        for (index, parent) in parents.into_iter().take(Self::MAX_PARENTS + 1).enumerate() {
            if index == Self::MAX_PARENTS {
                return Err(RecoveryError::ParentCount);
            }
            let id = parent.txid();
            if previous.insert(id, parent).is_some() {
                return Err(RecoveryError::DuplicateParent(id));
            }
        }
        let spent_outputs = transaction
            .transaction()
            .input
            .iter()
            .map(|input| {
                let reference = input.previous_output;
                let outpoint = Outpoint::new(
                    ConsensusTxid::from(reference.txid.to_byte_array()).into(),
                    reference.vout,
                );
                let parent = previous
                    .get(&outpoint.txid())
                    .ok_or(RecoveryError::MissingParent(outpoint))?;
                parent
                    .transaction()
                    .output
                    .get(reference.vout as usize)
                    .cloned()
                    .ok_or(RecoveryError::ParentOutput(outpoint))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            deployment,
            policy,
            transaction,
            spent_outputs,
            dlp_upper_bound,
        })
    }
    pub const fn deployment(&self) -> &DeploymentManifest {
        &self.deployment
    }
    pub const fn policy(&self) -> &PolicySnapshot {
        &self.policy
    }
    pub const fn transaction(&self) -> &TransactionRecord {
        &self.transaction
    }
    pub fn spent_outputs(&self) -> &[TxOut] {
        &self.spent_outputs
    }
    pub const fn dlp_upper_bound(&self) -> Option<RecoveryBound> {
        self.dlp_upper_bound
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryFields {
    deployment: DeploymentManifest,
    policy: PolicySnapshot,
    transaction: TransactionRecord,
    #[serde(deserialize_with = "parse_parents")]
    previous_transactions: Vec<TransactionRecord>,
    #[serde(default, deserialize_with = "parse_bound")]
    dlp_upper_bound: Option<RecoveryBound>,
}
fn parse_parents<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Vec<TransactionRecord>, D::Error> {
    crate::transaction::wire::bounded_transactions::<D, { RecoveryRequest::MAX_PARENTS }>(decoder)
}
fn parse_bound<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<RecoveryBound>, D::Error> {
    match u64::deserialize(decoder)? {
        0 => Ok(None),
        value => value.try_into().map(Some).map_err(serde::de::Error::custom),
    }
}
impl TryFrom<RecoveryFields> for RecoveryRequest {
    type Error = RecoveryError;
    fn try_from(fields: RecoveryFields) -> Result<Self, Self::Error> {
        Self::new(
            fields.deployment,
            fields.policy,
            fields.transaction,
            fields.previous_transactions,
            fields.dlp_upper_bound,
        )
    }
}
