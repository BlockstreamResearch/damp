use crate::network::DeploymentNetwork;
use elements::{Address, AddressParams, secp256k1_zkp::PublicKey};
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum AddressError {
    #[error("recipient is not a valid Elements address: {0}")]
    Encoding(#[from] elements::AddressError),
    #[error("recipient address must be confidential")]
    Unconfidential,
    #[error("recipient address must use Liquid testnet or Elements regtest")]
    Network,
    #[error("recipient address must use its canonical spelling")]
    Canonical,
}

/// A parsed confidential test-network address. Deployment ownership is checked separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ConfidentialAddress {
    address: Address,
    blinding_key: PublicKey,
    network: DeploymentNetwork,
}

impl ConfidentialAddress {
    pub fn as_address(&self) -> &Address {
        &self.address
    }
    pub const fn blinding_key(&self) -> PublicKey {
        self.blinding_key
    }
    pub const fn network(&self) -> DeploymentNetwork {
        self.network
    }
}

impl TryFrom<Address> for ConfidentialAddress {
    type Error = AddressError;
    fn try_from(address: Address) -> Result<Self, Self::Error> {
        let network = if address.params == &AddressParams::LIQUID_TESTNET {
            DeploymentNetwork::LiquidTestnet
        } else if address.params == &AddressParams::ELEMENTS {
            DeploymentNetwork::ElementsRegtest
        } else {
            return Err(AddressError::Network);
        };
        let blinding_key = address
            .blinding_pubkey
            .ok_or(AddressError::Unconfidential)?;
        Ok(Self {
            address,
            blinding_key,
            network,
        })
    }
}

impl FromStr for ConfidentialAddress {
    type Err = AddressError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let address: Address = value.parse()?;
        if address.to_string() != value {
            return Err(AddressError::Canonical);
        }
        address.try_into()
    }
}
impl TryFrom<String> for ConfidentialAddress {
    type Error = AddressError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}
impl From<ConfidentialAddress> for String {
    fn from(value: ConfidentialAddress) -> Self {
        value.to_string()
    }
}
impl fmt::Display for ConfidentialAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.address.fmt(f)
    }
}
