use anyhow::Context;
use damp_core::registry::DeploymentNetwork;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::pset::PartiallySignedTransaction;
use elements::{Address, Script};
use lwk_common::Signer as _;
use lwk_signer::SwSigner;

use crate::keys::WalletKeyLocator;

use crate::network::address_params;

pub fn add_wallet_metadata(
    signer: &SwSigner,
    pset: &mut PartiallySignedTransaction,
    input_index: usize,
    locator: &WalletKeyLocator,
    expected_script: &Script,
) -> anyhow::Result<()> {
    let path = crate::keys::derive::wallet_path(locator.branch, locator.index);
    let xprv = crate::keys::derive::derive_path(signer, &path)?;
    let public_key = BitcoinPublicKey::new(
        xprv.secret_key()
            .public_key(elements::secp256k1_zkp::SECP256K1),
    );
    let address = Address::p2wpkh(&public_key, None, &elements::AddressParams::ELEMENTS);
    anyhow::ensure!(
        &address.script_pubkey() == expected_script,
        "wallet derivation does not own the selected input"
    );
    let input = pset
        .inputs_mut()
        .get_mut(input_index)
        .context("wallet input index is out of range")?;
    input
        .bip32_derivation
        .insert(public_key, (signer.fingerprint(), path));
    Ok(())
}

pub fn wallet_address(
    signer: &SwSigner,
    network: DeploymentNetwork,
    locator: &WalletKeyLocator,
) -> anyhow::Result<Address> {
    let path = crate::keys::derive::wallet_path(locator.branch, locator.index);
    let xprv = crate::keys::derive::derive_path(signer, &path)?;
    let public_key = BitcoinPublicKey::new(
        xprv.secret_key()
            .public_key(elements::secp256k1_zkp::SECP256K1),
    );
    let master = signer
        .slip77_master_blinding_key()
        .map_err(|error| anyhow::anyhow!("LWK SLIP77 key unavailable: {error:?}"))?;
    let unconfidential = Address::p2wpkh(&public_key, None, address_params(network));
    let blinding_key = master.blinding_key(
        elements::secp256k1_zkp::SECP256K1,
        &unconfidential.script_pubkey(),
    );
    Ok(Address::p2wpkh(
        &public_key,
        Some(blinding_key),
        address_params(network),
    ))
}
