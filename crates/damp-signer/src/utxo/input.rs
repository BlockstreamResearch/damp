use damp_core::ledger::{ConsensusTxid, Outpoint};
use elements::hashes::Hash as _;
use elements::{Transaction, TxOut};
use serde::{Deserialize, Serialize};

use super::{UtxoError, wire::UtxoFields};
use crate::keys::{HolderKeyLocator, WalletKeyLocator};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputSource {
    Output(TxOut),
    Parent(Transaction),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    Unlocated,
    Wallet(WalletKeyLocator),
    Holder(HolderKeyLocator),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputStatus {
    Pending,
    Spendable,
}

/// Parsed transaction data and one ownership locator for an exact output.
/// Spendability is the caller's observation, not proof of current chain state.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "UtxoFields", into = "UtxoFields")]
pub struct Utxo {
    outpoint: Outpoint,
    source: InputSource,
    ownership: Ownership,
    status: InputStatus,
}

impl std::fmt::Debug for Utxo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Utxo")
            .field("outpoint", &self.outpoint)
            .field("ownership", &self.ownership)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl Utxo {
    pub fn new(
        outpoint: Outpoint,
        source: InputSource,
        ownership: Ownership,
        status: InputStatus,
    ) -> Result<Self, UtxoError> {
        if let InputSource::Parent(transaction) = &source {
            if transaction.txid().to_byte_array()
                != ConsensusTxid::from(outpoint.txid()).to_byte_array()
            {
                return Err(UtxoError::ParentId);
            }
            if transaction.output.get(outpoint.vout() as usize).is_none() {
                return Err(UtxoError::OutputIndex);
            }
        }
        Ok(Self {
            outpoint,
            source,
            ownership,
            status,
        })
    }
    pub const fn outpoint(&self) -> Outpoint {
        self.outpoint
    }
    pub const fn ownership(&self) -> Ownership {
        self.ownership
    }
    pub const fn status(&self) -> InputStatus {
        self.status
    }
    pub fn txout(&self) -> &TxOut {
        match &self.source {
            InputSource::Output(output) => output,
            // Construction checked the index against this immutable parent.
            InputSource::Parent(transaction) => &transaction.output[self.outpoint.vout() as usize],
        }
    }
    pub const fn wallet_key(&self) -> Option<&WalletKeyLocator> {
        match &self.ownership {
            Ownership::Wallet(key) => Some(key),
            _ => None,
        }
    }
    pub const fn holder_key(&self) -> Option<&HolderKeyLocator> {
        match &self.ownership {
            Ownership::Holder(key) => Some(key),
            _ => None,
        }
    }
}

impl TryFrom<UtxoFields> for Utxo {
    type Error = UtxoError;
    fn try_from(value: UtxoFields) -> Result<Self, Self::Error> {
        let source = match (value.tx_out, value.transaction) {
            (Some(raw), None) => InputSource::Output(parse_consensus(&raw, "serialized output")?),
            (None, Some(raw)) => InputSource::Parent(parse_consensus(&raw, "parent transaction")?),
            _ => return Err(UtxoError::Source),
        };
        let ownership = match (value.wallet_key, value.holder_key) {
            (None, None) => Ownership::Unlocated,
            (Some(key), None) => Ownership::Wallet(key),
            (None, Some(key)) => Ownership::Holder(key),
            _ => return Err(UtxoError::Ownership),
        };
        Self::new(
            Outpoint::new(value.txid, value.vout),
            source,
            ownership,
            if value.spendable {
                InputStatus::Spendable
            } else {
                InputStatus::Pending
            },
        )
    }
}

fn parse_consensus<T: elements::encode::Decodable>(
    raw: &str,
    field: &'static str,
) -> Result<T, UtxoError> {
    let bytes = hex::decode(raw).map_err(|_| UtxoError::Encoding { field })?;
    elements::encode::deserialize(&bytes).map_err(|_| UtxoError::Encoding { field })
}

impl From<Utxo> for UtxoFields {
    fn from(value: Utxo) -> Self {
        let (wallet_key, holder_key) = (value.wallet_key().copied(), value.holder_key().copied());
        let (tx_out, transaction) = match value.source {
            InputSource::Output(output) => (Some(elements::encode::serialize_hex(&output)), None),
            InputSource::Parent(parent) => (None, Some(elements::encode::serialize_hex(&parent))),
        };
        Self {
            txid: value.outpoint.txid(),
            vout: value.outpoint.vout(),
            tx_out,
            transaction,
            spendable: value.status == InputStatus::Spendable,
            wallet_key,
            holder_key,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedUtxo {
    pub txid: String,
    pub vout: u32,
    pub asset_id: String,
    pub amount: String,
    pub script_pubkey: String,
    pub asset_confidential: bool,
    pub value_confidential: bool,
}
