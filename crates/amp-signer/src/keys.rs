use std::str::FromStr;

use anyhow::Context;
use elements::Address;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::bitcoin::bip32::DerivationPath;
use elements::secp256k1_zkp::{Keypair, PublicKey, XOnlyPublicKey};
use elements_miniscript::bitcoin::bip32::Xpriv;
use lwk_common::Signer as _;
use lwk_signer::SwSigner;
use sha2::{Digest, Sha256};

use crate::model::{DerivedWalletAddress, SIGNER_SDK_VERSION, SignerNetwork};

pub fn derive_key_index(deployment_salt: &str, role: &str) -> anyhow::Result<u32> {
    let salt = amp_core::policy::decode_hex_32("deployment salt", deployment_salt)?;
    anyhow::ensure!(
        matches!(role, "holder" | "issuer"),
        "key role must be holder or issuer"
    );
    let mut hasher = Sha256::new();
    hasher.update(b"simplicity-amp/key-index/v1");
    hasher.update(salt);
    hasher.update(role.as_bytes());
    let hash: [u8; 32] = hasher.finalize().into();
    Ok(u32::from_be_bytes(hash[..4].try_into()?) & 0x7fff_ffff)
}

pub fn amp_derivation_path(role: &str, index: u32) -> anyhow::Result<DerivationPath> {
    let branch = match role {
        "holder" => 0,
        "issuer" => 1,
        _ => anyhow::bail!("key role must be holder or issuer"),
    };
    DerivationPath::from_str(&format!("m/87'/1'/0'/{branch}/{index}"))
        .context("invalid AMP derivation path")
}

pub fn derive_xprv(
    signer: &SwSigner,
    role: &str,
    index: u32,
) -> anyhow::Result<(DerivationPath, Xpriv)> {
    let path = amp_derivation_path(role, index)?;
    let xprv = signer
        .derive_xprv(&path)
        .context("could not derive AMP private key")?;
    Ok((path, xprv))
}

pub fn xonly_from_xprv(xprv: &Xpriv) -> XOnlyPublicKey {
    let keypair = Keypair::from_secret_key(elements::secp256k1_zkp::SECP256K1, &xprv.private_key);
    keypair.x_only_public_key().0
}

pub fn blinding_public_key(
    signer: &SwSigner,
    script: &elements::Script,
) -> anyhow::Result<PublicKey> {
    let master = signer
        .slip77_master_blinding_key()
        .map_err(|error| anyhow::anyhow!("LWK SLIP77 key unavailable: {error:?}"))?;
    Ok(master.blinding_key(elements::secp256k1_zkp::SECP256K1, script))
}

pub fn signer_descriptor(signer: &SwSigner) -> anyhow::Result<String> {
    signer
        .wpkh_slip77_descriptor()
        .map_err(|error| anyhow::anyhow!("could not create LWK descriptor: {error}"))
}

pub fn derive_wallet_address(
    signer: &SwSigner,
    network: SignerNetwork,
    branch: u32,
    index: u32,
) -> anyhow::Result<DerivedWalletAddress> {
    anyhow::ensure!(branch <= 1, "wallet derivation branch must be 0 or 1");
    anyhow::ensure!(index <= 0x7fff_ffff, "wallet derivation index is too large");
    let path = DerivationPath::from_str(&format!("m/84'/1'/0'/{branch}/{index}"))?;
    let xprv = signer.derive_xprv(&path)?;
    let public_key = BitcoinPublicKey::new(
        xprv.private_key
            .public_key(elements::secp256k1_zkp::SECP256K1),
    );
    let unconfidential = Address::p2wpkh(&public_key, None, network.address_params());
    let master = signer
        .slip77_master_blinding_key()
        .map_err(|error| anyhow::anyhow!("LWK SLIP77 key unavailable: {error:?}"))?;
    let blinding_key = master.blinding_key(
        elements::secp256k1_zkp::SECP256K1,
        &unconfidential.script_pubkey(),
    );
    let address = Address::p2wpkh(&public_key, Some(blinding_key), network.address_params());
    Ok(DerivedWalletAddress {
        sdk: SIGNER_SDK_VERSION,
        branch,
        index,
        derivation_path: path.to_string(),
        confidential_address: address.to_string(),
        script_pubkey: hex::encode(address.script_pubkey().as_bytes()),
    })
}
