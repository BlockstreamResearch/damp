use std::{fmt, str::FromStr};

use secp256k1_zkp::{PublicKey, XOnlyPublicKey};
use serde::{Deserialize, Serialize};

use crate::{encoding::hex_bytes, error::ParseError};

/// A curve-checked x-only public key, encoded as 32-byte lowercase hex.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct XOnlyKey(XOnlyPublicKey);

impl XOnlyKey {
    #[must_use]
    pub const fn public_key(self) -> XOnlyPublicKey {
        self.0
    }
    #[must_use]
    pub fn to_byte_array(self) -> [u8; 32] {
        self.0.serialize()
    }
}
impl From<XOnlyPublicKey> for XOnlyKey {
    fn from(value: XOnlyPublicKey) -> Self {
        Self(value)
    }
}
impl TryFrom<[u8; 32]> for XOnlyKey {
    type Error = ParseError;
    fn try_from(value: [u8; 32]) -> Result<Self, Self::Error> {
        XOnlyPublicKey::from_slice(&value)
            .map(Self)
            .map_err(|_| ParseError::CurvePoint {
                field: "x-only key",
            })
    }
}
impl FromStr for XOnlyKey {
    type Err = ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::try_from(hex_bytes("x-only key", value)?)
    }
}
impl TryFrom<String> for XOnlyKey {
    type Error = ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<XOnlyKey> for String {
    fn from(value: XOnlyKey) -> Self {
        value.to_string()
    }
}
impl fmt::Display for XOnlyKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl fmt::Debug for XOnlyKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("XOnlyKey").field(&self.to_string()).finish()
    }
}

/// A curve-checked issuer audit key in compressed SEC1 form.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AuditPublicKey(PublicKey);

impl AuditPublicKey {
    #[must_use]
    pub const fn public_key(self) -> PublicKey {
        self.0
    }
    #[must_use]
    pub fn to_byte_array(self) -> [u8; 33] {
        self.0.serialize()
    }
}
impl From<PublicKey> for AuditPublicKey {
    fn from(value: PublicKey) -> Self {
        Self(value)
    }
}
impl FromStr for AuditPublicKey {
    type Err = ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let bytes: [u8; 33] = hex_bytes("audit public key", value)?;
        PublicKey::from_slice(&bytes)
            .map(Self)
            .map_err(|_| ParseError::CurvePoint {
                field: "audit public key",
            })
    }
}
impl TryFrom<String> for AuditPublicKey {
    type Error = ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<AuditPublicKey> for String {
    fn from(value: AuditPublicKey) -> Self {
        value.to_string()
    }
}
impl fmt::Display for AuditPublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0.serialize()))
    }
}
impl fmt::Debug for AuditPublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("AuditPublicKey")
            .field(&self.to_string())
            .finish()
    }
}
