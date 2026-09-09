use std::{fmt, str::FromStr};

use damp_core::ledger::{ConsensusTxid, Txid};
use elements::{Transaction, hashes::Hash as _};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum TransactionEncodingError {
    #[error("transaction exceeds the {maximum}-byte limit")]
    Size { maximum: usize },
    #[error("transaction must be nonempty lowercase hex")]
    Hex,
    #[error("invalid transaction encoding: {0}")]
    Consensus(#[from] elements::encode::Error),
}

/// A decoded Elements transaction, not evidence of consensus validity or chain inclusion.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct TransactionRecord {
    transaction: Transaction,
    txid: Txid,
    encoded_size: usize,
}
impl TransactionRecord {
    pub const MAX_ENCODED_BYTES: usize = 4_000_000;

    /// Retain a native transaction and its calculated identity.
    ///
    /// # Errors
    /// Rejects an encoding larger than `MAX_ENCODED_BYTES`.
    pub fn new(transaction: Transaction) -> Result<Self, TransactionEncodingError> {
        let encoded_size = transaction.size();
        if encoded_size > Self::MAX_ENCODED_BYTES {
            return Err(TransactionEncodingError::Size {
                maximum: Self::MAX_ENCODED_BYTES,
            });
        }
        let txid = ConsensusTxid::from(transaction.txid().to_byte_array()).into();
        Ok(Self {
            transaction,
            txid,
            encoded_size,
        })
    }
    pub const fn transaction(&self) -> &Transaction {
        &self.transaction
    }
    pub const fn txid(&self) -> Txid {
        self.txid
    }
    pub const fn encoded_size(&self) -> usize {
        self.encoded_size
    }
    pub fn into_transaction(self) -> Transaction {
        self.transaction
    }
}
impl FromStr for TransactionRecord {
    type Err = TransactionEncodingError;
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.len() > Self::MAX_ENCODED_BYTES * 2 {
            return Err(TransactionEncodingError::Size {
                maximum: Self::MAX_ENCODED_BYTES,
            });
        }
        if text.is_empty()
            || !text.len().is_multiple_of(2)
            || !text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(TransactionEncodingError::Hex);
        }
        let bytes = hex::decode(text).map_err(|_| TransactionEncodingError::Hex)?;
        Self::new(elements::encode::deserialize(&bytes)?)
    }
}
impl TryFrom<String> for TransactionRecord {
    type Error = TransactionEncodingError;
    fn try_from(text: String) -> Result<Self, Self::Error> {
        text.parse()
    }
}
impl Serialize for TransactionRecord {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&elements::encode::serialize_hex(&self.transaction))
    }
}
impl fmt::Display for TransactionRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&elements::encode::serialize_hex(&self.transaction))
    }
}
impl fmt::Debug for TransactionRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TransactionRecord")
            .field("txid", &self.txid)
            .field("encoded_size", &self.encoded_size)
            .finish_non_exhaustive()
    }
}
