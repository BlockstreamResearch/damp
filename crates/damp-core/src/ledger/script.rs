use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};

use crate::error::ParseError;

/// A nonempty script, represented as lowercase hex at JSON boundaries.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ScriptPubkey(Vec<u8>);

impl ScriptPubkey {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

impl TryFrom<Vec<u8>> for ScriptPubkey {
    type Error = ParseError;
    fn try_from(value: Vec<u8>) -> Result<Self, Self::Error> {
        if value.is_empty() {
            return Err(ParseError::Script);
        }
        Ok(Self(value))
    }
}

impl FromStr for ScriptPubkey {
    type Err = ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.is_empty()
            || !value.len().is_multiple_of(2)
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ParseError::Script);
        }
        hex::decode(value)
            .map_err(|_| ParseError::Script)?
            .try_into()
    }
}
impl TryFrom<String> for ScriptPubkey {
    type Error = ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<ScriptPubkey> for String {
    fn from(value: ScriptPubkey) -> Self {
        value.to_string()
    }
}
impl fmt::Display for ScriptPubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(&self.0))
    }
}
impl fmt::Debug for ScriptPubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("ScriptPubkey")
            .field(&self.to_string())
            .finish()
    }
}
