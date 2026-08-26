use std::str::FromStr;

use amp_core::registry::{DeploymentManifestV1, DeploymentNetwork};
use anyhow::Context;
use elements::Address;
use lwk_signer::SwSigner;

use crate::keys::{derive_key_index, derive_xprv, xonly_from_xprv};
use crate::model::{DerivedHolderAddress, SIGNER_SDK_VERSION, SignerNetwork};
use crate::policy::protocol_for_deployment;

pub fn derive_holder_address(
    signer: &SwSigner,
    network: SignerNetwork,
    deployment: DeploymentManifestV1,
) -> anyhow::Result<DerivedHolderAddress> {
    deployment.validate()?;
    ensure_network(network, deployment.network)?;
    let index = derive_key_index(&deployment.deployment_salt, "holder")?;
    let (_, xprv) = derive_xprv(signer, "holder", index)?;
    let owner = xonly_from_xprv(&xprv);
    let owner_public = xprv
        .private_key
        .public_key(elements::secp256k1_zkp::SECP256K1);
    let protocol = protocol_for_deployment(&deployment)?;
    let script = protocol.user_script(owner)?;
    // Regulated AMP outputs are explicit. Encoding the holder public key as the
    // address blinding key makes the covenant owner recoverable from the
    // standard confidential address without exporting a parallel JSON record.
    let address = Address::from_script(&script, Some(owner_public), protocol.address_params())
        .context("holder script cannot be represented as an Elements address")?;
    validate_recipient_address(network, &deployment, &address.to_string())?;
    Ok(DerivedHolderAddress {
        sdk: SIGNER_SDK_VERSION,
        derivation_index: index,
        owner_public_key: owner.to_string(),
        script_pubkey: hex::encode(script.as_bytes()),
        confidential_address: address.to_string(),
    })
}

pub fn validate_recipient_address(
    network: SignerNetwork,
    deployment: &DeploymentManifestV1,
    confidential_address: &str,
) -> anyhow::Result<elements::schnorr::XOnlyPublicKey> {
    deployment.validate()?;
    ensure_network(network, deployment.network)?;
    let protocol = protocol_for_deployment(deployment)?;
    let address = Address::from_str(confidential_address)
        .context("recipient is not a valid Elements address")?;
    anyhow::ensure!(
        address.params == protocol.address_params(),
        "recipient address network mismatch"
    );
    let owner_public = address
        .blinding_pubkey
        .context("recipient address must be confidential")?;
    let owner = owner_public.x_only_public_key().0;
    anyhow::ensure!(
        address.script_pubkey() == protocol.user_script(owner)?,
        "recipient address is not a holder address for the selected deployment"
    );
    Ok(owner)
}

pub(crate) fn ensure_network(
    network: SignerNetwork,
    deployment: DeploymentNetwork,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(
            (network, deployment),
            (
                SignerNetwork::LiquidTestnet,
                DeploymentNetwork::LiquidTestnet
            ) | (
                SignerNetwork::ElementsRegtest,
                DeploymentNetwork::ElementsRegtest
            )
        ),
        "signer network does not match deployment"
    );
    Ok(())
}
