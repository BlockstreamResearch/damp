use std::{fmt, str::FromStr};

use damp_core::error::ParseError;
use serde::{Deserialize, Serialize};

/// Deployment key branches have distinct derivation domains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyRole {
    Holder,
    Issuer,
    Audit,
    Report,
}

impl KeyRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Holder => "holder",
            Self::Issuer => "issuer",
            Self::Audit => "audit",
            Self::Report => "report",
        }
    }

    pub(crate) const fn branch(self) -> u32 {
        match self {
            Self::Holder => 0,
            Self::Issuer => 1,
            Self::Audit => 2,
            Self::Report => 3,
        }
    }
}

impl fmt::Display for KeyRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for KeyRole {
    type Err = crate::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "holder" => Ok(Self::Holder),
            "issuer" => Ok(Self::Issuer),
            "audit" => Ok(Self::Audit),
            "report" => Ok(Self::Report),
            _ => Err(crate::Error::KeyRole),
        }
    }
}

/// An unhardened child index in the inclusive range 0 through 2^31-1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u32")]
pub struct KeyIndex(u32);

impl KeyIndex {
    pub const ZERO: Self = Self(0);

    pub const fn get(self) -> u32 {
        self.0
    }
}

impl TryFrom<u32> for KeyIndex {
    type Error = ParseError;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        if value <= 0x7fff_ffff {
            Ok(Self(value))
        } else {
            Err(ParseError::Bound {
                field: "key index",
                minimum: 0,
                maximum: 0x7fff_ffff,
            })
        }
    }
}

impl From<KeyIndex> for u32 {
    fn from(value: KeyIndex) -> Self {
        value.0
    }
}

impl fmt::Display for KeyIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// BIP84 external receiving and internal change branches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "u32", into = "u32")]
pub enum WalletBranch {
    Receive,
    Change,
}

impl WalletBranch {
    pub const fn get(self) -> u32 {
        match self {
            Self::Receive => 0,
            Self::Change => 1,
        }
    }
}

impl TryFrom<u32> for WalletBranch {
    type Error = ParseError;

    fn try_from(value: u32) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Receive),
            1 => Ok(Self::Change),
            _ => Err(ParseError::Bound {
                field: "wallet branch",
                minimum: 0,
                maximum: 1,
            }),
        }
    }
}

impl From<WalletBranch> for u32 {
    fn from(value: WalletBranch) -> Self {
        value.get()
    }
}

impl fmt::Display for WalletBranch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.get().fmt(f)
    }
}
