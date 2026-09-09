use anyhow::Context;
use damp_core::ledger::XOnlyKey;
use damp_core::registry::{DeploymentId, DeploymentManifest};
use elements::Address;
use lwk_signer::SwSigner;

use crate::SIGNER_SDK_VERSION;
use crate::covenant::policy::protocol_for_deployment;
use crate::keys::ConfidentialAddress;
use crate::keys::derive::{derive_key_index, derive_xprv, xonly_from_xprv};
use crate::keys::info::DerivedHolderAddress;
use crate::network::{DeploymentNetwork, require_network};

/// A parsed recipient whose script and network match one deployment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HolderRecipient {
    address: ConfidentialAddress,
    owner: XOnlyKey,
    deployment_id: DeploymentId,
}

impl HolderRecipient {
    pub fn address(&self) -> &ConfidentialAddress {
        &self.address
    }
    pub const fn owner(&self) -> XOnlyKey {
        self.owner
    }
    pub const fn deployment_id(&self) -> DeploymentId {
        self.deployment_id
    }
}

pub(crate) fn derive_holder_address(
    signer: &SwSigner,
    network: DeploymentNetwork,
    deployment: &DeploymentManifest,
) -> anyhow::Result<DerivedHolderAddress> {
    require_network(network, deployment.network())?;
    let index = derive_key_index(&deployment.deployment_salt(), crate::keys::KeyRole::Holder)?;
    let (_, xprv) = derive_xprv(signer, crate::keys::KeyRole::Holder, index)?;
    let owner = xonly_from_xprv(&xprv);
    let owner_public = xprv
        .secret_key()
        .public_key(elements::secp256k1_zkp::SECP256K1);
    let protocol = protocol_for_deployment(deployment)?;
    let script = protocol.user_script(owner)?;
    // The blinding key also identifies the holder authorized by this script.
    let address = Address::from_script(&script, Some(owner_public), protocol.address_params())
        .context("holder script cannot be represented as an Elements address")?;
    Ok(DerivedHolderAddress {
        sdk: SIGNER_SDK_VERSION,
        derivation_index: index,
        owner_public_key: owner.to_string(),
        script_pubkey: hex::encode(script.as_bytes()),
        confidential_address: address.try_into()?,
    })
}

pub(crate) fn validate_recipient_address(
    network: DeploymentNetwork,
    deployment: &DeploymentManifest,
    address: &ConfidentialAddress,
) -> anyhow::Result<HolderRecipient> {
    require_network(network, deployment.network())?;
    require_network(network, address.network())?;
    let owner = address.blinding_key().x_only_public_key().0;
    let protocol = protocol_for_deployment(deployment)?;
    anyhow::ensure!(
        address.as_address().script_pubkey() == protocol.user_script(owner)?,
        "recipient address is not a holder address for the selected deployment"
    );
    Ok(HolderRecipient {
        address: address.clone(),
        owner: owner.into(),
        deployment_id: deployment.deployment_id(),
    })
}
