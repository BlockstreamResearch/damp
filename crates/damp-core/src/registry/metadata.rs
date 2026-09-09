use crate::error::ParseError;
use crate::ledger::AuditPublicKey;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "MetadataFields", into = "MetadataFields")]
pub struct AssetMetadata {
    name: String,
    ticker: String,
    precision: u8,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MetadataFields {
    name: String,
    ticker: String,
    precision: u8,
}

impl AssetMetadata {
    /// Check display-name byte lengths and decimal precision.
    ///
    /// # Errors
    /// Rejects blank or oversized names and tickers, and precision above eight.
    pub fn new(name: String, ticker: String, precision: u8) -> Result<Self, ParseError> {
        if name.trim() != name || !(1..=80).contains(&name.len()) {
            return Err(ParseError::Text {
                field: "asset name",
                minimum: 1,
                maximum: 80,
            });
        }
        if ticker.trim() != ticker || !(1..=12).contains(&ticker.len()) {
            return Err(ParseError::Text {
                field: "asset ticker",
                minimum: 1,
                maximum: 12,
            });
        }
        if precision > 8 {
            return Err(ParseError::Bound {
                field: "asset precision",
                minimum: 0,
                maximum: 8,
            });
        }
        Ok(Self {
            name,
            ticker,
            precision,
        })
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn ticker(&self) -> &str {
        &self.ticker
    }
    pub const fn precision(&self) -> u8 {
        self.precision
    }
}
impl TryFrom<MetadataFields> for AssetMetadata {
    type Error = ParseError;
    fn try_from(value: MetadataFields) -> Result<Self, Self::Error> {
        Self::new(value.name, value.ticker, value.precision)
    }
}
impl From<AssetMetadata> for MetadataFields {
    fn from(value: AssetMetadata) -> Self {
        Self {
            name: value.name,
            ticker: value.ticker,
            precision: value.precision,
        }
    }
}

/// A positive audit epoch representable exactly by browser JSON numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct AuditEpoch(u64);
impl AuditEpoch {
    pub const INITIAL: Self = Self(1);
    pub const fn get(self) -> u64 {
        self.0
    }
}
impl TryFrom<u64> for AuditEpoch {
    type Error = ParseError;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if !(1..=9_007_199_254_740_991).contains(&value) {
            return Err(ParseError::Bound {
                field: "audit epoch",
                minimum: 1,
                maximum: 9_007_199_254_740_991,
            });
        }
        Ok(Self(value))
    }
}
impl From<AuditEpoch> for u64 {
    fn from(value: AuditEpoch) -> Self {
        value.0
    }
}

/// Audit parameters contain only public data; both fields validate during parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuditConfig {
    pub public_key: AuditPublicKey,
    pub epoch: AuditEpoch,
}
