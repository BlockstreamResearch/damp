use anyhow::Context;
use elements::bitcoin::bip32::{ChildNumber, DerivationPath};
use elements::secp256k1_zkp::{Keypair, SecretKey, XOnlyPublicKey};
use elements_miniscript::bitcoin::bip32::Xpriv;
use lwk_common::Signer as _;
use lwk_signer::SwSigner;
use sha2::{Digest, Sha256};

use super::{KeyIndex, KeyRole, WalletBranch};
use crate::SIGNER_SDK_VERSION;
use crate::keys::info::DerivedWalletAddress;
use crate::network::DeploymentNetwork;

pub(crate) fn derive_key_index(
    deployment_salt: &damp_core::registry::DeploymentSalt,
    role: KeyRole,
) -> anyhow::Result<KeyIndex> {
    let salt = deployment_salt.to_byte_array();
    let mut hasher = Sha256::new();
    hasher.update(b"simplicity-damp/key-index/v1");
    hasher.update(salt);
    hasher.update(role.as_str().as_bytes());
    let hash: [u8; 32] = hasher.finalize().into();
    Ok(KeyIndex::try_from(
        u32::from_be_bytes(hash[..4].try_into()?) & 0x7fff_ffff,
    )?)
}

fn path(purpose: u32, branch: u32, index: KeyIndex) -> DerivationPath {
    DerivationPath::from(vec![
        ChildNumber::Hardened { index: purpose },
        ChildNumber::Hardened { index: 1 },
        ChildNumber::Hardened { index: 0 },
        ChildNumber::Normal { index: branch },
        ChildNumber::Normal { index: index.get() },
    ])
}

pub(crate) fn wallet_path(branch: WalletBranch, index: KeyIndex) -> DerivationPath {
    path(84, branch.get(), index)
}

pub(crate) struct ProtectedXpriv(Xpriv);

impl std::fmt::Debug for ProtectedXpriv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProtectedXpriv([REDACTED])")
    }
}

impl ProtectedXpriv {
    pub(crate) fn secret_key(&self) -> SecretKey {
        self.0.private_key
    }
}

impl Drop for ProtectedXpriv {
    fn drop(&mut self) {
        self.0.private_key.non_secure_erase();
    }
}

pub(crate) fn derive_path(
    signer: &SwSigner,
    path: &DerivationPath,
) -> anyhow::Result<ProtectedXpriv> {
    signer
        .derive_xprv(path)
        .map(ProtectedXpriv)
        .context("could not derive private key")
}

pub(crate) fn derive_xprv(
    signer: &SwSigner,
    role: KeyRole,
    index: KeyIndex,
) -> anyhow::Result<(DerivationPath, ProtectedXpriv)> {
    let path = path(87, role.branch(), index);
    let key = derive_path(signer, &path)?;
    Ok((path, key))
}

pub(crate) fn xonly_from_xprv(xprv: &ProtectedXpriv) -> XOnlyPublicKey {
    let keypair = Keypair::from_secret_key(elements::secp256k1_zkp::SECP256K1, &xprv.0.private_key);
    keypair.x_only_public_key().0
}

pub(crate) fn signer_descriptor(signer: &SwSigner) -> anyhow::Result<String> {
    signer
        .wpkh_slip77_descriptor()
        .map_err(|error| anyhow::anyhow!("could not create LWK descriptor: {error}"))
}

pub(crate) fn derive_wallet_address(
    signer: &SwSigner,
    network: DeploymentNetwork,
    branch: WalletBranch,
    index: KeyIndex,
) -> anyhow::Result<DerivedWalletAddress> {
    let path = wallet_path(branch, index);
    let address = crate::keys::wallet::wallet_address(
        signer,
        network,
        &super::WalletKeyLocator { branch, index },
    )?;
    Ok(DerivedWalletAddress {
        sdk: SIGNER_SDK_VERSION,
        branch: branch.get(),
        index: index.get(),
        derivation_path: path.to_string(),
        script_pubkey: hex::encode(address.script_pubkey().as_bytes()),
        confidential_address: address.try_into()?,
    })
}
