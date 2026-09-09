use std::{fmt, num::NonZeroU64, str::FromStr};

use serde::{Deserialize, Serialize};

use crate::error::ParseError;

/// A positive number of base units, serialized as canonical decimal text.
///
/// ```
/// use simplicity_damp_core::ledger::Amount;
/// let amount: Amount = "1000".parse()?;
/// assert_eq!(amount.get(), 1000);
/// # Ok::<(), simplicity_damp_core::error::ParseError>(())
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Amount(NonZeroU64);

impl Amount {
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}
impl TryFrom<u64> for Amount {
    type Error = ParseError;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        NonZeroU64::new(value).map(Self).ok_or(ParseError::Amount)
    }
}
impl FromStr for Amount {
    type Err = ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let number = value.parse::<u64>().map_err(|_| ParseError::Amount)?;
        if value != number.to_string() {
            return Err(ParseError::Amount);
        }
        Self::try_from(number)
    }
}
impl TryFrom<String> for Amount {
    type Error = ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<Amount> for String {
    fn from(value: Amount) -> Self {
        value.to_string()
    }
}
impl fmt::Display for Amount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// An amount the application may issue or transfer, from 1 through `2^63-1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AuditAmount(Amount);

impl AuditAmount {
    pub const MAX: u64 = i64::MAX as u64;
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}
impl TryFrom<Amount> for AuditAmount {
    type Error = ParseError;
    fn try_from(value: Amount) -> Result<Self, Self::Error> {
        if value.get() > Self::MAX {
            return Err(ParseError::Bound {
                field: "audit amount",
                minimum: 1,
                maximum: Self::MAX,
            });
        }
        Ok(Self(value))
    }
}
impl TryFrom<u64> for AuditAmount {
    type Error = ParseError;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        Amount::try_from(value)?.try_into()
    }
}
impl FromStr for AuditAmount {
    type Err = ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        value.parse::<Amount>()?.try_into()
    }
}
impl TryFrom<String> for AuditAmount {
    type Error = ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<AuditAmount> for String {
    fn from(value: AuditAmount) -> Self {
        value.to_string()
    }
}
impl From<AuditAmount> for Amount {
    fn from(value: AuditAmount) -> Self {
        value.0
    }
}
impl fmt::Display for AuditAmount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
