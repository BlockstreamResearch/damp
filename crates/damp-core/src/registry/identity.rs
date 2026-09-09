use crate::encoding::hex_value;

hex_value!(
    DeploymentId,
    "deployment id",
    "Identity of the immutable deployment parameters."
);
hex_value!(
    ProgramHash,
    "program hash",
    "Hash of a compiled executable leaf."
);
hex_value!(
    BundleHash,
    "contract bundle hash",
    "Hash of sorted authored contract paths and bytes."
);
hex_value!(
    IssuanceEntropy,
    "issuance entropy",
    "Entropy that identifies an Elements asset issuance."
);
hex_value!(
    ScriptHash,
    "script hash",
    "SHA-256 of script bytes, not their hex representation."
);

impl IssuanceEntropy {
    pub fn from_consensus_byte_array(mut bytes: [u8; 32]) -> Self {
        bytes.reverse();
        bytes.into()
    }

    pub fn to_consensus_byte_array(self) -> [u8; 32] {
        let mut bytes = self.to_byte_array();
        bytes.reverse();
        bytes
    }
}

/// A nonzero salt for deployment-scoped key derivation and audit statements.
#[derive(
    Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(try_from = "String", into = "String")]
pub struct DeploymentSalt([u8; 32]);

impl DeploymentSalt {
    pub const fn to_byte_array(self) -> [u8; 32] {
        self.0
    }
}

impl TryFrom<[u8; 32]> for DeploymentSalt {
    type Error = crate::error::ParseError;
    fn try_from(bytes: [u8; 32]) -> Result<Self, Self::Error> {
        if bytes == [0; 32] {
            return Err(crate::error::ParseError::ZeroSalt);
        }
        Ok(Self(bytes))
    }
}

impl std::str::FromStr for DeploymentSalt {
    type Err = crate::error::ParseError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        crate::encoding::hex_bytes("deployment salt", value)?.try_into()
    }
}

impl TryFrom<String> for DeploymentSalt {
    type Error = crate::error::ParseError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<DeploymentSalt> for String {
    fn from(value: DeploymentSalt) -> Self {
        value.to_string()
    }
}
impl std::fmt::Display for DeploymentSalt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}
impl std::fmt::Debug for DeploymentSalt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("DeploymentSalt")
            .field(&self.to_string())
            .finish()
    }
}
