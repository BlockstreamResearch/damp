//! Registry records and the signer use the same test-network identity.
pub use damp_core::registry::DeploymentNetwork;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("signer network {signer:?} does not match requested network {requested:?}")]
pub struct NetworkMismatch {
    pub signer: DeploymentNetwork,
    pub requested: DeploymentNetwork,
}

pub(crate) const fn address_params(network: DeploymentNetwork) -> &'static elements::AddressParams {
    match network {
        DeploymentNetwork::LiquidTestnet => &elements::AddressParams::LIQUID_TESTNET,
        DeploymentNetwork::ElementsRegtest => &elements::AddressParams::ELEMENTS,
    }
}

pub(crate) fn require_network(
    signer: DeploymentNetwork,
    requested: DeploymentNetwork,
) -> Result<(), NetworkMismatch> {
    if signer == requested {
        Ok(())
    } else {
        Err(NetworkMismatch { signer, requested })
    }
}
