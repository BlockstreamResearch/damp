use anyhow::Context;
use elements::confidential::{AssetBlindingFactor, Value, ValueBlindingFactor};
use elements::secp256k1_zkp::{Generator, SecretKey};
use elements::{AssetId, TxOut, TxOutSecrets};

pub(crate) fn unblind_value_only(
    txout: &TxOut,
    asset: AssetId,
    blinding_key: SecretKey,
) -> anyhow::Result<TxOutSecrets> {
    let commitment = match txout.value {
        Value::Confidential(commitment) => commitment,
        _ => anyhow::bail!("value-only unblinding requires a confidential value"),
    };
    let shared_secret = txout
        .nonce
        .shared_secret(&blinding_key)
        .context("value-only output is missing its ECDH nonce")?;
    let rangeproof = txout
        .witness
        .rangeproof
        .as_ref()
        .context("value-only output is missing its range proof")?;
    let generator = Generator::new_unblinded(elements::secp256k1_zkp::SECP256K1, asset.into_tag());
    let (opening, _) = rangeproof.rewind(
        elements::secp256k1_zkp::SECP256K1,
        commitment,
        shared_secret,
        txout.script_pubkey.as_bytes(),
        generator,
    )?;
    anyhow::ensure!(
        opening.message.len() >= 64,
        "value-only range proof message is truncated"
    );
    let proven_asset = AssetId::from_byte_array(opening.message[..32].try_into()?);
    let proven_asset_bf = AssetBlindingFactor::from_slice(&opening.message[32..64])?;
    anyhow::ensure!(
        proven_asset == asset,
        "value-only proof commits another asset"
    );
    anyhow::ensure!(
        proven_asset_bf == AssetBlindingFactor::zero(),
        "value-only proof carries a non-zero asset blinder"
    );
    Ok(TxOutSecrets::new(
        asset,
        AssetBlindingFactor::zero(),
        opening.value,
        ValueBlindingFactor::from_slice(opening.blinding_factor.as_ref())?,
    ))
}
