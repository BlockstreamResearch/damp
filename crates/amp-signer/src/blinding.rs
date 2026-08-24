use std::collections::HashMap;

use anyhow::Context;
use elements::confidential::{AssetBlindingFactor, Value, ValueBlindingFactor};
use elements::pset::PartiallySignedTransaction;
use elements::secp256k1_zkp::{
    Generator, PedersenCommitment, RangeProof, SecretKey, SurjectionProof,
    verify_commitments_sum_to_equal,
};
use elements::{
    AssetId, BlindAssetProofs, BlindValueProofs, RangeProofMessage, SurjectionInput, TxOut,
    TxOutSecrets,
};
use rand::thread_rng;

/// AMP-specific value-only blinding for non-regulated wallet outputs. Regulated values stay
/// explicit because the covenant sums and constrains them in Simplicity. LWK supplies the input
/// SLIP77 secrets; this protocol layer only balances and proves explicitly selected fee-asset
/// values.
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
        anyhow::ensure!(
            last_vbf != ValueBlindingFactor::zero(),
            "value-only balancing produced a zero blinding factor for asset {asset}"
        );

        for index in indexes {
            let value_bf = if index == last_index {
                last_vbf
            } else {
                *blinders
                    .get(&index)
                    .context("missing output value blinder")?
            };
            blind_explicit_asset_value(pset, index, asset, value_bf, &mut rng)
                .with_context(|| format!("value-only output {index} for asset {asset}"))?;
        }
        let input_commitments = input_balance
            .iter()
            .filter(|entry| entry.0 > 0)
            .map(|entry| balance_commitment(asset, *entry))
            .collect::<Vec<_>>();
        let output_commitments = pset
            .outputs()
            .iter()
            .filter(|output| output.asset == Some(asset))
            .map(|output| {
                if let Some(commitment) = output.amount_comm {
                    Ok(commitment)
                } else {
                    let value = output
                        .amount
                        .context("same-asset output is missing its amount")?;
                    Ok(balance_commitment(
                        asset,
                        (
                            value,
                            AssetBlindingFactor::zero(),
                            ValueBlindingFactor::zero(),
                        ),
                    ))
                }
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        anyhow::ensure!(
            verify_commitments_sum_to_equal(
                elements::secp256k1_zkp::SECP256K1,
                &input_commitments,
                &output_commitments,
            ),
            "value-only commitments do not balance for asset {asset}"
        );
    }
    Ok(())
}

/// Fully confidentialize one reissuance-token output without involving any other asset group.
///
/// The token must carry a non-zero asset blinding factor or it cannot authorize a later
/// reissuance. Using the PSET-wide last-blinder algorithm here would count confidential L-BTC
/// inputs a second time after [`blind_values`] has already balanced them, so this helper proves and
/// balances only the selected token asset. Caller-supplied asset IDs remain explicit PSET
/// metadata.
pub fn blind_assets_and_values(
    pset: &mut PartiallySignedTransaction,
    input_secrets: &HashMap<usize, TxOutSecrets>,
    output_indices: &[usize],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        output_indices.len() == 1,
        "exactly one fully confidential token output is required"
    );
    let output_index = output_indices[0];
    let output = pset
        .outputs()
        .get(output_index)
        .context("output index is out of range")?;
    let asset = output
        .asset
        .context("token output asset must be explicit")?;
    let value = output
        .amount
        .context("token output amount must be explicit")?;
    let blinding_key = output
        .blinding_key
        .context("token output needs a blinding public key")?
        .inner;
    let script_pubkey = output.script_pubkey.clone();
    anyhow::ensure!(
        output.asset_comm.is_none() && output.amount_comm.is_none(),
        "token output is already blinded"
    );
    anyhow::ensure!(
        pset.outputs()
            .iter()
            .enumerate()
            .all(|(index, candidate)| index == output_index || candidate.asset != Some(asset)),
        "token asset must have exactly one transaction output"
    );

    let mut input_balance = input_secrets
        .values()
        .filter(|secret| secret.asset == asset)
        .map(|secret| (secret.value, secret.asset_bf, secret.value_bf))
        .collect::<Vec<_>>();
    for input in pset.inputs().iter().filter(|input| input.has_issuance()) {
        let (issued_asset, token_asset) = input.issuance_ids();
        if issued_asset == asset {
            if let Some(amount) = input.issuance_value_amount {
                input_balance.push((
                    amount,
                    AssetBlindingFactor::zero(),
                    ValueBlindingFactor::zero(),
                ));
            } else {
                anyhow::ensure!(
                    input.issuance_value_comm.is_none(),
                    "token-asset issuance amount must be explicit"
                );
            }
        }
        if token_asset == asset {
            if let Some(amount) = input.issuance_inflation_keys {
                input_balance.push((
                    amount,
                    AssetBlindingFactor::zero(),
                    ValueBlindingFactor::zero(),
                ));
            } else {
                anyhow::ensure!(
                    input.issuance_inflation_keys_comm.is_none(),
                    "reissuance-token amount must be explicit"
                );
            }
        }
    }
    anyhow::ensure!(
        !input_balance.is_empty(),
        "no input balance for token asset {asset}"
    );
    let input_value = input_balance.iter().try_fold(0u64, |sum, entry| {
        sum.checked_add(entry.0)
            .context("token input amount overflow")
    })?;
    anyhow::ensure!(
        input_value == value,
        "token input and output amounts do not balance"
    );

    let mut rng = thread_rng();
    let asset_bf = AssetBlindingFactor::new(&mut rng);
    let value_bf = ValueBlindingFactor::last(
        elements::secp256k1_zkp::SECP256K1,
        value,
        asset_bf,
        &input_balance,
        &[],
    );
    anyhow::ensure!(
        asset_bf != AssetBlindingFactor::zero() && value_bf != ValueBlindingFactor::zero(),
        "token blinding produced a zero blinding factor"
    );
    let surjection_inputs = canonical_surjection_inputs(pset, input_secrets)?;
    let ephemeral_key = SecretKey::new(&mut rng);
    let txout = TxOut::with_txout_secrets(
        &mut rng,
        elements::secp256k1_zkp::SECP256K1,
        script_pubkey,
        blinding_key,
        ephemeral_key,
        TxOutSecrets::new(asset, asset_bf, value, value_bf),
        &surjection_inputs,
    )?;
    let asset_commitment = txout
        .asset
        .commitment()
        .context("token asset blinding made no commitment")?;
    let amount_commitment = txout
        .value
        .commitment()
        .context("token value blinding made no commitment")?;
    let surjection_domain = surjection_inputs
        .iter()
        .map(|input| {
            input
                .surjection_target(elements::secp256k1_zkp::SECP256K1)
                .map(|target| target.0)
        })
        .collect::<Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        txout
            .witness
            .surjection_proof
            .as_ref()
            .is_some_and(|proof| {
                proof.verify(
                    elements::secp256k1_zkp::SECP256K1,
                    asset_commitment,
                    &surjection_domain,
                )
            }),
        "token asset surjection proof did not verify against the PSET input domain"
    );
    let output = &mut pset.outputs_mut()[output_index];
    output.asset_comm = Some(asset_commitment);
    output.amount_comm = Some(amount_commitment);
    output.ecdh_pubkey = txout
        .nonce
        .commitment()
        .map(|key| elements::bitcoin::PublicKey {
            inner: key,
            compressed: true,
        });
    output.asset_surjection_proof = txout.witness.surjection_proof;
    output.value_rangeproof = txout.witness.rangeproof;
    output.blind_asset_proof = Some(Box::new(SurjectionProof::blind_asset_proof(
        &mut rng,
        elements::secp256k1_zkp::SECP256K1,
        asset,
        asset_bf,
    )?));
    output.blind_value_proof = Some(Box::new(RangeProof::blind_value_proof(
        &mut rng,
        elements::secp256k1_zkp::SECP256K1,
        value,
        amount_commitment,
        asset_commitment,
        value_bf,
    )?));
    anyhow::ensure!(
        output.asset_comm.is_some() && output.amount_comm.is_some(),
        "selected token output did not become fully confidential"
    );
    anyhow::ensure!(
        output.asset_surjection_proof.is_some()
            && output.value_rangeproof.is_some()
            && output.ecdh_pubkey.is_some(),
        "selected token output is missing confidential proofs"
    );
    anyhow::ensure!(
        output.blind_asset_proof.is_some() && output.blind_value_proof.is_some(),
        "selected token output is missing PSET blinding proofs"
    );
    let input_commitments = input_balance
        .iter()
        .filter(|entry| entry.0 > 0)
        .map(|entry| balance_commitment(asset, *entry))
        .collect::<Vec<_>>();
    anyhow::ensure!(
        verify_commitments_sum_to_equal(
            elements::secp256k1_zkp::SECP256K1,
            &input_commitments,
            &[amount_commitment],
        ),
        "token input and output commitments do not balance"
    );
    if output.blinder_index.is_some() {
        // The output is fully blinded by this process; no later PSET participant must count it.
        output.blinder_index = None;
    }
    Ok(())
}

/// Match the transaction consensus surjection domain and reject explicit zero issuance fields,
/// which Elements considers invalid rather than equivalent to null.
pub(crate) fn canonical_surjection_inputs(
    pset: &PartiallySignedTransaction,
    input_secrets: &HashMap<usize, TxOutSecrets>,
) -> anyhow::Result<Vec<SurjectionInput>> {
    let mut domain = Vec::new();
    for (index, input) in pset.inputs().iter().enumerate() {
        let spent = input
            .witness_utxo
            .as_ref()
            .with_context(|| format!("input {index} is missing its spent output"))?;
        domain.push(match input_secrets.get(&index) {
            Some(secret) => SurjectionInput::from_txout_secrets(*secret),
            None => SurjectionInput::Unknown(spent.asset),
        });
        if input.has_issuance() {
            let (issued_asset, token_asset) = input.issuance_ids();
            anyhow::ensure!(
                input.issuance_value_amount != Some(0) && input.issuance_inflation_keys != Some(0),
                "input {index} contains an invalid zero-valued issuance"
            );
            if input.issuance_value_amount.is_some_and(|amount| amount > 0)
                || input.issuance_value_comm.is_some()
            {
                domain.push(SurjectionInput::Known {
                    asset: issued_asset,
                    asset_bf: AssetBlindingFactor::zero(),
                });
            }
            if input
                .issuance_inflation_keys
                .is_some_and(|amount| amount > 0)
                || input.issuance_inflation_keys_comm.is_some()
            {
                domain.push(SurjectionInput::Known {
                    asset: token_asset,
                    asset_bf: AssetBlindingFactor::zero(),
                });
            }
        }
    }
    Ok(domain)
}

fn balance_commitment(
    asset: AssetId,
    (value, asset_bf, value_bf): (u64, AssetBlindingFactor, ValueBlindingFactor),
) -> PedersenCommitment {
    let generator = Generator::new_blinded(
        elements::secp256k1_zkp::SECP256K1,
        asset.into_tag(),
        asset_bf.into_inner(),
    );
    if value_bf == ValueBlindingFactor::zero() {
        PedersenCommitment::new_unblinded(elements::secp256k1_zkp::SECP256K1, value, generator)
    } else {
        PedersenCommitment::new(
            elements::secp256k1_zkp::SECP256K1,
            value,
            value_bf.into_inner(),
            generator,
        )
    }
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
