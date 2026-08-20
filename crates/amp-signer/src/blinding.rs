use std::collections::HashMap;

use anyhow::Context;
use elements::confidential::{AssetBlindingFactor, Value, ValueBlindingFactor};
use elements::pset::PartiallySignedTransaction;
use elements::secp256k1_zkp::{Generator, RangeProof, SecretKey};
use elements::{AssetId, BlindValueProofs, RangeProofMessage, TxOutSecrets};
use rand::thread_rng;

/// AMP-specific value-only output blinding. Assets remain explicit because the verifier scans and
/// compares every regulated asset ID in Simplicity. LWK supplies the input SLIP77 secrets; this
/// protocol layer only balances and proves the selected values.
pub fn blind_values(
    pset: &mut PartiallySignedTransaction,
    input_secrets: &HashMap<usize, TxOutSecrets>,
    output_indices: &[usize],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !output_indices.is_empty(),
        "no confidential output was selected"
    );
    let mut grouped: HashMap<AssetId, Vec<usize>> = HashMap::new();
    for index in output_indices {
        let output = pset
            .outputs()
            .get(*index)
            .context("output index is out of range")?;
        let asset = output.asset.context("output asset must be explicit")?;
        anyhow::ensure!(
            output.amount.is_some(),
            "output amount must be explicit before blinding"
        );
        anyhow::ensure!(
            output.blinding_key.is_some(),
            "output needs a blinding public key"
        );
        anyhow::ensure!(
            output.asset_comm.is_none() && output.amount_comm.is_none(),
            "output is already blinded"
        );
        let indexes = grouped.entry(asset).or_default();
        anyhow::ensure!(
            !indexes.contains(index),
            "duplicate confidential output index"
        );
        indexes.push(*index);
    }

    let mut rng = thread_rng();
    for (asset, indexes) in grouped {
        let mut input_balance = input_secrets
            .values()
            .filter(|secret| secret.asset == asset)
            .map(|secret| (secret.value, secret.asset_bf, secret.value_bf))
            .collect::<Vec<_>>();
        for input in pset.inputs().iter().filter(|input| input.has_issuance()) {
            let (issued_asset, token_asset) = input.issuance_ids();
            if issued_asset == asset {
                input_balance.push((
                    input
                        .issuance_value_amount
                        .context("issuance amount must be explicit for value-only blinding")?,
                    AssetBlindingFactor::zero(),
                    ValueBlindingFactor::zero(),
                ));
            }
            if token_asset == asset {
                input_balance.push((
                    input
                        .issuance_inflation_keys
                        .context("token amount must be explicit for value-only blinding")?,
                    AssetBlindingFactor::zero(),
                    ValueBlindingFactor::zero(),
                ));
            }
        }
        anyhow::ensure!(
            !input_balance.is_empty(),
            "no input balance for output asset {asset}"
        );
        let last_index = *indexes.last().expect("non-empty group");
        let mut output_balance = Vec::new();
        let mut blinders = HashMap::new();
        for (index, output) in pset.outputs().iter().enumerate() {
            if output.asset != Some(asset) || index == last_index {
                continue;
            }
            let value = output
                .amount
                .context("same-asset output is missing its amount")?;
            let value_bf = if indexes.contains(&index) {
                ValueBlindingFactor::new(&mut rng)
            } else {
                ValueBlindingFactor::zero()
            };
            blinders.insert(index, value_bf);
            output_balance.push((value, AssetBlindingFactor::zero(), value_bf));
        }
        let last_value = pset.outputs()[last_index]
            .amount
            .context("last confidential output is missing its amount")?;
        let last_vbf = ValueBlindingFactor::last(
            elements::secp256k1_zkp::SECP256K1,
            last_value,
            AssetBlindingFactor::zero(),
            &input_balance,
            &output_balance,
        );

        for index in indexes {
            let value_bf = if index == last_index {
                last_vbf
            } else {
                *blinders
                    .get(&index)
                    .context("missing output value blinder")?
            };
            blind_explicit_asset_value(pset, index, asset, value_bf, &mut rng)?;
        }
    }
    Ok(())
}

/// Fully confidentialize selected outputs with Elements' standard PSET blinder. This is used only
/// for reissuance-token outputs: the token must carry a non-zero asset blinding factor or it cannot
/// authorize a later reissuance. All caller-supplied asset IDs remain explicit PSET metadata.
pub fn blind_assets_and_values(
    pset: &mut PartiallySignedTransaction,
    input_secrets: &HashMap<usize, TxOutSecrets>,
    output_indices: &[usize],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !output_indices.is_empty(),
        "no fully confidential output was selected"
    );
    let first_input = *input_secrets
        .keys()
        .min()
        .context("input secrets are required")?;
    let first_input = u32::try_from(first_input)?;
    let originals = pset.outputs().to_vec();
    for index in output_indices {
        let output = pset
            .outputs_mut()
            .get_mut(*index)
            .context("output index is out of range")?;
        anyhow::ensure!(
            output.asset.is_some() && output.amount.is_some() && output.blinding_key.is_some(),
            "fully confidential output needs explicit asset, value and blinding key"
        );
        output.blinder_index.get_or_insert(first_input);
    }
    for (index, output) in pset.outputs_mut().iter_mut().enumerate() {
        if !output_indices.contains(&index) {
            output.blinding_key = None;
            output.blinder_index = None;
        }
    }
    pset.blind_last(
        &mut thread_rng(),
        elements::secp256k1_zkp::SECP256K1,
        input_secrets,
    )?;
    for (index, original) in originals.iter().enumerate() {
        if !output_indices.contains(&index) {
            pset.outputs_mut()[index].blinding_key = original.blinding_key;
            pset.outputs_mut()[index].blinder_index = original.blinder_index;
        }
    }
    for index in output_indices {
        let output = &pset.outputs()[*index];
        anyhow::ensure!(
            output.asset_comm.is_some() && output.amount_comm.is_some(),
            "selected token output did not become fully confidential"
        );
    }
    Ok(())
}

fn blind_explicit_asset_value<R: rand::RngCore + rand::CryptoRng>(
    pset: &mut PartiallySignedTransaction,
    index: usize,
    asset: AssetId,
    value_bf: ValueBlindingFactor,
    rng: &mut R,
) -> anyhow::Result<()> {
    let output = &pset.outputs()[index];
    let value = output.amount.context("output amount is missing")?;
    let blinding_key = output
        .blinding_key
        .context("output blinding key is missing")?
        .inner;
    let script_pubkey = output.script_pubkey.clone();
    let asset_generator =
        Generator::new_unblinded(elements::secp256k1_zkp::SECP256K1, asset.into_tag());
    let message = RangeProofMessage {
        asset,
        bf: AssetBlindingFactor::zero(),
    };
    let (commitment, nonce, rangeproof) = Value::Explicit(value).blind(
        elements::secp256k1_zkp::SECP256K1,
        value_bf,
        blinding_key,
        SecretKey::new(rng),
        &script_pubkey,
        &message,
    )?;
    let amount_commitment = commitment
        .commitment()
        .context("value blinding made no commitment")?;
    let output = &mut pset.outputs_mut()[index];
    output.amount_comm = Some(amount_commitment);
    output.ecdh_pubkey = nonce.commitment().map(|key| elements::bitcoin::PublicKey {
        inner: key,
        compressed: true,
    });
    output.value_rangeproof = Some(Box::new(rangeproof));
    output.blind_value_proof = Some(Box::new(RangeProof::blind_value_proof(
        rng,
        elements::secp256k1_zkp::SECP256K1,
        value,
        amount_commitment,
        asset_generator,
        value_bf,
    )?));
    Ok(())
}
