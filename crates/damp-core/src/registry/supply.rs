use super::{IssuanceEntropy, RegistryError};
use crate::ledger::AssetId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SupplyMode {
    Fixed,
    IssuerManaged,
}

/// Fixed supply has no reissuance credentials. Managed supply requires both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Supply {
    Fixed,
    IssuerManaged {
        token: AssetId,
        entropy: IssuanceEntropy,
    },
}

impl Supply {
    pub(crate) fn from_fields(
        mode: SupplyMode,
        token: Option<AssetId>,
        entropy: Option<IssuanceEntropy>,
    ) -> Result<Self, RegistryError> {
        match (mode, token, entropy) {
            (SupplyMode::Fixed, None, None) => Ok(Self::Fixed),
            (SupplyMode::IssuerManaged, Some(token), Some(entropy)) => {
                Ok(Self::IssuerManaged { token, entropy })
            }
            _ => Err(RegistryError::SupplyConfiguration),
        }
    }
    pub const fn mode(self) -> SupplyMode {
        match self {
            Self::Fixed => SupplyMode::Fixed,
            Self::IssuerManaged { .. } => SupplyMode::IssuerManaged,
        }
    }
    pub const fn token(self) -> Option<AssetId> {
        match self {
            Self::Fixed => None,
            Self::IssuerManaged { token, .. } => Some(token),
        }
    }
    pub const fn entropy(self) -> Option<IssuanceEntropy> {
        match self {
            Self::Fixed => None,
            Self::IssuerManaged { entropy, .. } => Some(entropy),
        }
    }
}
