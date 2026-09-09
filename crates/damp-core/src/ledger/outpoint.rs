use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

use crate::{encoding::hex_value, error::ParseError};

hex_value!(
    Txid,
    "transaction id",
    "A transaction identifier in displayed byte order."
);

/// A transaction identifier in consensus serialization order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConsensusTxid([u8; 32]);

impl ConsensusTxid {
    #[must_use]
    pub const fn to_byte_array(self) -> [u8; 32] {
        self.0
    }
}
impl From<[u8; 32]> for ConsensusTxid {
    fn from(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}
impl From<Txid> for ConsensusTxid {
    fn from(value: Txid) -> Self {
        let mut bytes = value.to_byte_array();
        bytes.reverse();
        Self(bytes)
    }
}
impl From<ConsensusTxid> for Txid {
    fn from(value: ConsensusTxid) -> Self {
        let mut bytes = value.0;
        bytes.reverse();
        bytes.into()
    }
}

/// An exact output reference. Its index is checked against transaction data when used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Outpoint {
    txid: Txid,
    vout: u32,
}

impl Outpoint {
    #[must_use]
    pub const fn new(txid: Txid, vout: u32) -> Self {
        Self { txid, vout }
    }
    #[must_use]
    pub const fn txid(self) -> Txid {
        self.txid
    }
    #[must_use]
    pub const fn vout(self) -> u32 {
        self.vout
    }
}
impl FromStr for Outpoint {
    type Err = ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (txid, index) = value.split_once(':').ok_or(ParseError::Outpoint)?;
        let txid = txid.parse()?;
        let vout = index.parse::<u32>().map_err(|_| ParseError::Outpoint)?;
        if index != vout.to_string() {
            return Err(ParseError::Outpoint);
        }
        Ok(Self::new(txid, vout))
    }
}
impl TryFrom<String> for Outpoint {
    type Error = ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<Outpoint> for String {
    fn from(value: Outpoint) -> Self {
        value.to_string()
    }
}
impl fmt::Display for Outpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.txid, self.vout)
    }
}
