use anyhow::Context;
use elements::confidential::{Asset, AssetBlindingFactor, Value, ValueBlindingFactor};
use elements::hashes::Hash as _;
use elements::{AssetId, OutPoint, TxOutSecrets, Txid};
use lwk_common::Signer as _;
use lwk_signer::SwSigner;

use crate::utxo::input::InspectedUtxo;
use crate::utxo::input::Utxo;

use super::unblind::unblind_value_only;
use super::validated::ValidatedUtxo;

pub fn decode_utxo(
    signer: &SwSigner,
    value: &Utxo,
    expected_asset: AssetId,
) -> anyhow::Result<ValidatedUtxo> {
    decode_utxo_inner(signer, value, DecodePurpose::Covenant(expected_asset))
}

pub fn decode_confidential_wallet_utxo(
    signer: &SwSigner,
    value: &Utxo,
    expected_asset: AssetId,
) -> anyhow::Result<ValidatedUtxo> {
    decode_utxo_inner(signer, value, DecodePurpose::WalletFunding(expected_asset))
}

pub fn inspect_utxos(signer: &SwSigner, values: &[Utxo]) -> anyhow::Result<Vec<InspectedUtxo>> {
    values
        .iter()
        .map(|value| {
            let validated = decode_utxo_inner(signer, value, DecodePurpose::Inspect)?;
            Ok(InspectedUtxo {
                txid: value.outpoint().txid().to_string(),
                vout: value.outpoint().vout(),
                asset_id: validated.opening().asset.to_string(),
                amount: validated.opening().value.to_string(),
                script_pubkey: hex::encode(validated.txout.script_pubkey.as_bytes()),
                asset_confidential: matches!(validated.txout.asset, Asset::Confidential(_)),
                value_confidential: matches!(validated.txout.value, Value::Confidential(_)),
            })
        })
        .collect()
}

enum DecodePurpose {
    Inspect,
    Covenant(AssetId),
    WalletFunding(AssetId),
}

fn decode_utxo_inner(
    signer: &SwSigner,
    value: &Utxo,
    purpose: DecodePurpose,
) -> anyhow::Result<ValidatedUtxo> {
    let (expected_asset, allow_confidential_asset) = match purpose {
        DecodePurpose::Inspect => (None, true),
        DecodePurpose::Covenant(asset) => (Some(asset), false),
        DecodePurpose::WalletFunding(asset) => (Some(asset), true),
    };
    if !matches!(purpose, DecodePurpose::Inspect) {
        anyhow::ensure!(
            value.status() == crate::utxo::InputStatus::Spendable,
            "selected UTXO is not spendable"
        );
    }
    let outpoint = value.outpoint();
    let txid = Txid::from_byte_array(
        damp_core::ledger::ConsensusTxid::from(outpoint.txid()).to_byte_array(),
    );
    let txout = value.txout().clone();
    let secrets = match (txout.asset, txout.value) {
        (Asset::Explicit(asset), Value::Explicit(amount)) => TxOutSecrets::new(
            asset,
            AssetBlindingFactor::zero(),
            amount,
            ValueBlindingFactor::zero(),
        ),
        (Asset::Explicit(asset), Value::Confidential(_)) => {
            let key = if let Some(holder) = value.holder_key() {
                let (_, key) = crate::keys::derive::derive_xprv(
                    signer,
                    crate::keys::KeyRole::Holder,
                    holder.derivation_index,
                )?;
                anyhow::ensure!(
                    crate::keys::derive::xonly_from_xprv(&key)
                        == holder.owner_public_key.public_key(),
                    "holder locator key mismatch"
                );
                key.secret_key()
            } else {
                signer
                    .slip77_master_blinding_key()
                    .map_err(|error| anyhow::anyhow!("LWK SLIP77 key unavailable: {error:?}"))?
                    .blinding_private_key(&txout.script_pubkey)
            };
            unblind_value_only(&txout, asset, key)?
        }
        (Asset::Confidential(_), Value::Confidential(_)) => {
            let master = signer
                .slip77_master_blinding_key()
                .map_err(|error| anyhow::anyhow!("LWK SLIP77 key unavailable: {error:?}"))?;
            txout
                .unblind(
                    elements::secp256k1_zkp::SECP256K1,
                    master.blinding_private_key(&txout.script_pubkey),
                )
                .context("could not unblind selected UTXO with this signer")?
        }
        _ => anyhow::bail!("selected UTXO is null or partially blinded"),
    };
    let validated = ValidatedUtxo {
        outpoint: OutPoint::new(txid, outpoint.vout()),
        txout,
        opening: secrets,
        ownership: value.ownership(),
    };
    if let Some(expected_asset) = expected_asset {
        anyhow::ensure!(
            validated.opening().asset == expected_asset,
            "selected UTXO has the wrong asset"
        );
    }
    if !allow_confidential_asset {
        anyhow::ensure!(
            validated.opening().asset_bf == AssetBlindingFactor::zero(),
            "DAMP requires this input asset ID to remain explicit"
        );
    }
    Ok(validated)
}
