use anyhow::Context;
use elements::confidential::{Asset, Value};
use elements::secp256k1_zkp::{Generator, PedersenCommitment, verify_commitments_sum_to_equal};
use elements::{Transaction, TxOut};

pub(crate) const MAX_EXPLICIT_MONEY: u64 = 2_100_000_000_000_000;

/// Verify all confidential proofs and the transaction-wide value balance before returning a
/// signer artifact. Explicit zero-valued issuance fields are invalid in Elements consensus, so
/// reject them explicitly instead of allowing the upstream convenience verifier to panic while
/// constructing their Pedersen commitments.
pub fn verify_transaction_amounts(
    transaction: &Transaction,
    spent_utxos: &[TxOut],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        transaction.input.len() == spent_utxos.len(),
        "transaction input and spent-output counts differ"
    );
    let secp = elements::secp256k1_zkp::SECP256K1;
    let mut input_commitments = Vec::new();
    let mut output_commitments = Vec::new();
    let surjection_domain = transaction_surjection_domain(transaction, spent_utxos)?;

    for (index, (input, spent)) in transaction.input.iter().zip(spent_utxos).enumerate() {
        let generator = txout_asset_generator(spent, index, "input")?;
        input_commitments.push(txout_value_commitment(spent, generator, index, "input")?);
        if input.has_issuance() {
            let (issued_asset, token_asset) = input.issuance_ids();
            for (value, asset, label, has_rangeproof) in [
                (
                    input.asset_issuance.amount,
                    issued_asset,
                    "issued asset",
                    input.witness.amount_rangeproof.is_some(),
                ),
                (
                    input.asset_issuance.inflation_keys,
                    token_asset,
                    "reissuance token",
                    input.witness.inflation_keys_rangeproof.is_some(),
                ),
            ] {
                anyhow::ensure!(
                    matches!(value, Value::Confidential(_)) || !has_rangeproof,
                    "input {index} has a range proof for an explicit {label} issuance"
                );
                match value {
                    Value::Null => {}
                    Value::Explicit(amount) => {
                        anyhow::ensure!(
                            amount > 0,
                            "input {index} has an invalid zero-valued {label} issuance"
                        );
                        let generator = Generator::new_unblinded(secp, asset.into_tag());
                        input_commitments
                            .push(PedersenCommitment::new_unblinded(secp, amount, generator));
                    }
                    Value::Confidential(commitment) => {
                        input_commitments.push(commitment);
                    }
                }
                anyhow::ensure!(
                    !matches!(value, Value::Confidential(_)),
                    "input {index} has an unsupported confidential {label} issuance"
                );
            }
        }
    }

    let explicit_total = transaction
        .output
        .iter()
        .filter_map(|o| o.value.explicit())
        .try_fold(0u128, |sum, value| sum.checked_add(u128::from(value)))
        .context("explicit output total overflow")?;
    anyhow::ensure!(
        explicit_total <= u128::from(MAX_EXPLICIT_MONEY),
        "explicit output total exceeds Elements MAX_MONEY; use confidential outputs"
    );
    for (index, output) in transaction.output.iter().enumerate() {
        if output.value == Value::Explicit(0) {
            anyhow::ensure!(
                output.script_pubkey.is_op_return()
                    && output.asset.is_explicit()
                    && output.nonce == elements::confidential::Nonce::Null
                    && output.witness.is_empty(),
                "output {index} has an invalid explicit zero value"
            );
            // The zero commitment is infinity; omit it from both group sums.
            continue;
        }
        let generator = txout_asset_generator(output, index, "output")?;
        let value_commitment = txout_value_commitment(output, generator, index, "output")?;
        output_commitments.push(value_commitment);
        if let Some(commitment) = output.value.commitment() {
            let rangeproof = output
                .witness
                .rangeproof
                .as_ref()
                .with_context(|| format!("output {index} is missing its value range proof"))?;
            rangeproof
                .verify(secp, commitment, output.script_pubkey.as_bytes(), generator)
                .with_context(|| format!("output {index} has an invalid value range proof"))?;
        } else {
            anyhow::ensure!(
                output.witness.rangeproof.is_none(),
                "output {index} has a range proof for an explicit value"
            );
        }
        if let Some(generator) = output.asset.commitment() {
            let proof =
                output.witness.surjection_proof.as_ref().with_context(|| {
                    format!("output {index} is missing its asset surjection proof")
                })?;
            anyhow::ensure!(
                proof.verify(secp, generator, &surjection_domain),
                "output {index} has an invalid asset surjection proof"
            );
        } else {
            anyhow::ensure!(
                output.witness.surjection_proof.is_none(),
                "output {index} has a surjection proof for an explicit asset"
            );
        }
    }
    anyhow::ensure!(
        verify_commitments_sum_to_equal(secp, &input_commitments, &output_commitments),
        "transaction input and output commitments do not balance"
    );
    Ok(())
}

pub(crate) fn transaction_surjection_domain(
    transaction: &Transaction,
    spent_utxos: &[TxOut],
) -> anyhow::Result<Vec<Generator>> {
    anyhow::ensure!(
        transaction.input.len() == spent_utxos.len(),
        "transaction input and spent-output counts differ"
    );
    let secp = elements::secp256k1_zkp::SECP256K1;
    let mut domain = Vec::new();
    for (index, (input, spent)) in transaction.input.iter().zip(spent_utxos).enumerate() {
        domain.push(txout_asset_generator(spent, index, "input")?);
        if input.has_issuance() {
            let (issued_asset, token_asset) = input.issuance_ids();
            for (value, asset) in [
                (input.asset_issuance.amount, issued_asset),
                (input.asset_issuance.inflation_keys, token_asset),
            ] {
                match value {
                    Value::Null => {}
                    Value::Explicit(0) => {
                        anyhow::bail!("input {index} contains an invalid zero-valued issuance")
                    }
                    Value::Explicit(_) | Value::Confidential(_) => {
                        domain.push(Generator::new_unblinded(secp, asset.into_tag()));
                    }
                }
            }
        }
    }
    Ok(domain)
}

fn txout_asset_generator(txout: &TxOut, index: usize, role: &str) -> anyhow::Result<Generator> {
    match txout.asset {
        Asset::Explicit(asset) => Ok(Generator::new_unblinded(
            elements::secp256k1_zkp::SECP256K1,
            asset.into_tag(),
        )),
        Asset::Confidential(generator) => Ok(generator),
        Asset::Null => anyhow::bail!("{role} {index} has no asset"),
    }
}

fn txout_value_commitment(
    txout: &TxOut,
    generator: Generator,
    index: usize,
    role: &str,
) -> anyhow::Result<PedersenCommitment> {
    match txout.value {
        Value::Explicit(value) => {
            anyhow::ensure!(value > 0, "{role} {index} has an explicit zero value");
            Ok(PedersenCommitment::new_unblinded(
                elements::secp256k1_zkp::SECP256K1,
                value,
                generator,
            ))
        }
        Value::Confidential(commitment) => Ok(commitment),
        Value::Null => anyhow::bail!("{role} {index} has no value"),
    }
}
