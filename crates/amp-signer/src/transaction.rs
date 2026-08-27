use std::str::FromStr;

use amp_core::registry::{DeploymentManifestV1, DeploymentNetwork};
use anyhow::Context;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::bitcoin::bip32::DerivationPath;
use elements::confidential::{Asset, AssetBlindingFactor, Value, ValueBlindingFactor};
use elements::pset::{Input, PartiallySignedTransaction};
use elements::secp256k1_zkp::{
    Generator, PedersenCommitment, SecretKey, verify_commitments_sum_to_equal,
};
use elements::{Address, AssetId, OutPoint, Script, Transaction, TxOut, TxOutSecrets, Txid};
use lwk_common::Signer as _;
use lwk_signer::SwSigner;

use crate::model::{HolderKeyLocator, InspectedUtxo, SpendableUtxo, WalletKeyLocator};

pub struct ValidatedUtxo {
    pub outpoint: OutPoint,
    pub txout: TxOut,
    pub secrets: TxOutSecrets,
    pub wallet_key: Option<WalletKeyLocator>,
    pub holder_key: Option<HolderKeyLocator>,
}

pub fn parse_amount(value: &str, name: &str) -> anyhow::Result<u64> {
    anyhow::ensure!(
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
        "{name} must be an unsigned decimal integer"
    );
    let amount = value
        .parse::<u64>()
        .with_context(|| format!("{name} must fit u64"))?;
    anyhow::ensure!(amount > 0, "{name} must be positive");
    Ok(amount)
}

/// Validate the reviewed fee against the exact finalized Liquid transaction shape.
///
/// LWK's transaction builder cannot construct the custom Simplicity inputs used here, so the
/// signer builds those inputs itself. Once every witness and proof is present, however, LWK's
/// fee utility can price the exact ELIP-200 discounted weight without relying on browser-side
/// byte-count guesses.
pub fn validate_network_fee(transaction: &Transaction, reviewed_fee: u64) -> anyhow::Result<()> {
    let paid_fee = transaction
        .output
        .iter()
        .filter(|output| output.is_fee())
        .try_fold(0u64, |sum, output| {
            let value = output
                .value
                .explicit()
                .context("fee output value must be explicit")?;
            sum.checked_add(value).context("transaction fee overflow")
        })?;
    anyhow::ensure!(
        paid_fee == reviewed_fee,
        "final transaction fee differs from the reviewed fee"
    );

    let minimum =
        lwk_common::calculate_fee(transaction.discount_weight(), lwk_common::DEFAULT_FEE_RATE);
    anyhow::ensure!(
        paid_fee >= minimum,
        "reviewed fee is below LWK's finalized transaction minimum of {minimum} sats"
    );
    Ok(())
}

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

    for (index, output) in transaction.output.iter().enumerate() {
        anyhow::ensure!(
            output.value != Value::Explicit(0),
            "output {index} has an explicit zero value"
        );
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

pub fn decode_utxo(
    signer: &SwSigner,
    value: &SpendableUtxo,
    expected_asset: AssetId,
) -> anyhow::Result<ValidatedUtxo> {
    decode_utxo_inner(signer, value, Some(expected_asset), false)
}

pub fn decode_confidential_wallet_utxo(
    signer: &SwSigner,
    value: &SpendableUtxo,
    expected_asset: AssetId,
) -> anyhow::Result<ValidatedUtxo> {
    decode_utxo_inner(signer, value, Some(expected_asset), true)
}

pub fn inspect_utxos(
    signer: &SwSigner,
    values: &[SpendableUtxo],
) -> anyhow::Result<Vec<InspectedUtxo>> {
    values
        .iter()
        .map(|value| {
            // Inspection is read-only and must classify pending outputs. Keep the
            // spendability gate in every transaction-building decoder, but do not
            // require a confirmation merely to unblind and display an output.
            let mut inspectable = value.clone();
            inspectable.spendable = true;
            let validated = decode_utxo_inner(signer, &inspectable, None, true)?;
            Ok(InspectedUtxo {
                txid: value.txid.clone(),
                vout: value.vout,
                asset_id: validated.secrets.asset.to_string(),
                amount: validated.secrets.value.to_string(),
                script_pubkey: hex::encode(validated.txout.script_pubkey.as_bytes()),
                asset_confidential: matches!(validated.txout.asset, Asset::Confidential(_)),
                value_confidential: matches!(validated.txout.value, Value::Confidential(_)),
            })
        })
        .collect()
}

fn decode_utxo_inner(
    signer: &SwSigner,
    value: &SpendableUtxo,
    expected_asset: Option<AssetId>,
    allow_confidential_asset: bool,
) -> anyhow::Result<ValidatedUtxo> {
    anyhow::ensure!(value.spendable, "selected UTXO is not spendable");
    let txid = Txid::from_str(&value.txid).context("invalid UTXO transaction ID")?;
    anyhow::ensure!(
        value.tx_out.is_some() ^ value.transaction.is_some(),
        "selected UTXO needs exactly one serialized TxOut or parent transaction"
    );
    let txout: TxOut = if let Some(serialized) = &value.tx_out {
        let bytes = hex::decode(serialized).context("invalid serialized TxOut hex")?;
        elements::encode::deserialize(&bytes).context("invalid serialized TxOut")?
    } else {
        let bytes = hex::decode(value.transaction.as_deref().expect("validated"))
            .context("invalid parent transaction hex")?;
        let transaction: elements::Transaction =
            elements::encode::deserialize(&bytes).context("invalid parent transaction")?;
        anyhow::ensure!(transaction.txid() == txid, "parent transaction ID mismatch");
        transaction
            .output
            .get(usize::try_from(value.vout)?)
            .cloned()
            .context("UTXO output index is out of range")?
    };
    let secrets = match (txout.asset, txout.value) {
        (Asset::Explicit(asset), Value::Explicit(amount)) => TxOutSecrets::new(
            asset,
            AssetBlindingFactor::zero(),
            amount,
            ValueBlindingFactor::zero(),
        ),
        (Asset::Explicit(asset), Value::Confidential(_)) => {
            let master = signer
                .slip77_master_blinding_key()
                .map_err(|error| anyhow::anyhow!("LWK SLIP77 key unavailable: {error:?}"))?;
            unblind_value_only(
                &txout,
                asset,
                master.blinding_private_key(&txout.script_pubkey),
            )?
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
    if let Some(expected_asset) = expected_asset {
        anyhow::ensure!(
            secrets.asset == expected_asset,
            "selected UTXO has the wrong asset"
        );
    }
    if !allow_confidential_asset {
        anyhow::ensure!(
            secrets.asset_bf == AssetBlindingFactor::zero(),
            "AMP v0.1 requires this input asset ID to remain explicit"
        );
    }
    Ok(ValidatedUtxo {
        outpoint: OutPoint::new(txid, value.vout),
        txout,
        secrets,
        wallet_key: value.wallet_key.clone(),
        holder_key: value.holder_key.clone(),
    })
}

fn unblind_value_only(
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

pub fn add_validated_input(pset: &mut PartiallySignedTransaction, utxo: &ValidatedUtxo) -> usize {
    let index = pset.inputs().len();
    let mut input = Input::from_prevout(utxo.outpoint);
    input.asset = Some(utxo.secrets.asset);
    input.amount = Some(utxo.secrets.value);
    input.witness_utxo = Some(utxo.txout.clone());
    pset.add_input(input);
    index
}

pub fn add_wallet_metadata(
    signer: &SwSigner,
    pset: &mut PartiallySignedTransaction,
    input_index: usize,
    locator: &WalletKeyLocator,
    expected_script: &Script,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        locator.branch <= 1,
        "wallet derivation branch must be 0 or 1"
    );
    anyhow::ensure!(
        locator.index <= 0x7fff_ffff,
        "wallet derivation index is too large"
    );
    let path =
        DerivationPath::from_str(&format!("m/84'/1'/0'/{}/{}", locator.branch, locator.index))?;
    let xprv = signer.derive_xprv(&path)?;
    let public_key = BitcoinPublicKey::new(
        xprv.private_key
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
    network: &DeploymentManifestV1,
    locator: &WalletKeyLocator,
) -> anyhow::Result<Address> {
    let path =
        DerivationPath::from_str(&format!("m/84'/1'/0'/{}/{}", locator.branch, locator.index))?;
    let xprv = signer.derive_xprv(&path)?;
    let public_key = BitcoinPublicKey::new(
        xprv.private_key
            .public_key(elements::secp256k1_zkp::SECP256K1),
    );
    let master = signer
        .slip77_master_blinding_key()
        .map_err(|error| anyhow::anyhow!("LWK SLIP77 key unavailable: {error:?}"))?;
    let unconfidential = Address::p2wpkh(&public_key, None, address_params(network.network));
    let blinding_key = master.blinding_key(
        elements::secp256k1_zkp::SECP256K1,
        &unconfidential.script_pubkey(),
    );
    Ok(Address::p2wpkh(
        &public_key,
        Some(blinding_key),
        address_params(network.network),
    ))
}

pub fn set_lwk_genesis_hash(
    pset: &mut PartiallySignedTransaction,
    deployment: &DeploymentManifestV1,
) -> anyhow::Result<()> {
    set_lwk_genesis_hash_for(
        pset,
        deployment.network,
        AssetId::from_str(&deployment.policy_asset)?,
    )
}

pub fn set_lwk_genesis_hash_for(
    pset: &mut PartiallySignedTransaction,
    deployment_network: DeploymentNetwork,
    policy_asset: AssetId,
) -> anyhow::Result<()> {
    let network = match deployment_network {
        DeploymentNetwork::LiquidTestnet => lwk_common::Network::TestnetLiquid,
        DeploymentNetwork::ElementsRegtest => {
            let params = lwk_common::ElementsParamsBuilder::new()
                .with_policy_asset(policy_asset)
                .build()?;
            lwk_common::Network::CustomElements(params)
        }
    };
    lwk_common::set_genesis_hash(pset, &network);
    Ok(())
}

pub fn finalize_lwk_wallet_inputs(
    signer: &SwSigner,
    pset: &mut PartiallySignedTransaction,
    expected_indexes: &[usize],
) -> anyhow::Result<()> {
    let signed = signer
        .sign(pset)
        .map_err(|error| anyhow::anyhow!("LWK signing failed: {error:?}"))?;
    anyhow::ensure!(
        signed == expected_indexes.len() as u32,
        "LWK signed an unexpected input set"
    );
    for index in expected_indexes {
        let input = pset
            .inputs_mut()
            .get_mut(*index)
            .context("signed wallet input index is out of range")?;
        anyhow::ensure!(
            input.partial_sigs.len() == 1,
            "wallet input needs exactly one signature"
        );
        let (public_key, signature) = input.partial_sigs.iter().next().expect("checked length");
        input.final_script_witness = Some(vec![signature.clone(), public_key.to_bytes()]);
    }
    Ok(())
}

pub fn address_params(network: DeploymentNetwork) -> &'static elements::AddressParams {
    match network {
        DeploymentNetwork::LiquidTestnet => &elements::AddressParams::LIQUID_TESTNET,
        DeploymentNetwork::ElementsRegtest => &elements::AddressParams::ELEMENTS,
    }
}

pub fn select_smallest_sufficient(
    mut values: Vec<ValidatedUtxo>,
    target: u64,
    max_inputs: usize,
) -> anyhow::Result<Vec<ValidatedUtxo>> {
    values.sort_by(|left, right| {
        left.secrets
            .value
            .cmp(&right.secrets.value)
            .then_with(|| left.outpoint.txid.cmp(&right.outpoint.txid))
            .then_with(|| left.outpoint.vout.cmp(&right.outpoint.vout))
    });
    if let Some(index) = values.iter().position(|utxo| utxo.secrets.value >= target) {
        return Ok(vec![values.swap_remove(index)]);
    }
    let mut selected = Vec::new();
    let mut total = 0u64;
    for utxo in values.into_iter().rev().take(max_inputs) {
        total = total
            .checked_add(utxo.secrets.value)
            .context("input amount overflow")?;
        selected.push(utxo);
        if total >= target {
            return Ok(selected);
        }
    }
    anyhow::bail!("insufficient balance")
}

/// Select fee inputs while preserving enough value to reblind change whenever any selected input
/// carries a confidential asset or value commitment. Exact-value explicit inputs remain usable;
/// exact-value confidential inputs are skipped in favor of a larger candidate.
pub fn select_fee_funding(
    mut values: Vec<ValidatedUtxo>,
    target: u64,
    max_inputs: usize,
    confidential_change: u64,
) -> anyhow::Result<Vec<ValidatedUtxo>> {
    anyhow::ensure!(max_inputs > 0, "fee selection allows no inputs");
    let confidential_target = target
        .checked_add(confidential_change)
        .context("fee target overflow")?;
    values.sort_by(|left, right| {
        left.secrets
            .value
            .cmp(&right.secrets.value)
            .then_with(|| left.outpoint.txid.cmp(&right.outpoint.txid))
            .then_with(|| left.outpoint.vout.cmp(&right.outpoint.vout))
    });

    if let Some(index) = values.iter().position(|utxo| {
        utxo.secrets.value
            >= if input_needs_confidential_change(utxo) {
                confidential_target
            } else {
                target
            }
    }) {
        return Ok(vec![values.swap_remove(index)]);
    }

    // Prefer an explicit-only combination when it can pay the exact fee. This
    // avoids imposing confidential-change headroom unnecessarily.
    let mut explicit_total = 0u64;
    let mut explicit_count = 0usize;
    for utxo in values
        .iter()
        .rev()
        .filter(|utxo| !input_needs_confidential_change(utxo))
        .take(max_inputs)
    {
        explicit_total = explicit_total
            .checked_add(utxo.secrets.value)
            .context("input amount overflow")?;
        explicit_count += 1;
        if explicit_total >= target {
            return Ok(values
                .into_iter()
                .rev()
                .filter(|utxo| !input_needs_confidential_change(utxo))
                .take(explicit_count)
                .collect());
        }
    }

    let mut selected = Vec::new();
    let mut total = 0u64;
    let mut needs_change = false;
    for utxo in values.into_iter().rev().take(max_inputs) {
        total = total
            .checked_add(utxo.secrets.value)
            .context("input amount overflow")?;
        needs_change |= input_needs_confidential_change(&utxo);
        selected.push(utxo);
        let required = if needs_change {
            confidential_target
        } else {
            target
        };
        if total >= required {
            return Ok(selected);
        }
    }
    anyhow::bail!("insufficient balance with confidential-change headroom")
}

pub(crate) fn input_needs_confidential_change(utxo: &ValidatedUtxo) -> bool {
    utxo.secrets.asset_bf != AssetBlindingFactor::zero()
        || utxo.secrets.value_bf != ValueBlindingFactor::zero()
}

#[cfg(test)]
mod fee_selection_tests {
    use super::*;
    use elements::TxOutWitness;
    use elements::confidential::Nonce;

    fn candidate(value: u64, id: u8, confidential: bool) -> ValidatedUtxo {
        let asset = AssetId::from_str(&"11".repeat(32)).expect("asset");
        let value_bf = if confidential {
            ValueBlindingFactor::new(&mut rand::thread_rng())
        } else {
            ValueBlindingFactor::zero()
        };
        ValidatedUtxo {
            outpoint: OutPoint::new(Txid::from_str(&format!("{id:064x}")).expect("txid"), 0),
            txout: TxOut {
                asset: Asset::Explicit(asset),
                value: Value::Explicit(value),
                nonce: Nonce::Null,
                script_pubkey: Script::new(),
                witness: TxOutWitness::default(),
            },
            secrets: TxOutSecrets::new(asset, AssetBlindingFactor::zero(), value, value_bf),
            wallet_key: None,
            holder_key: None,
        }
    }

    #[test]
    fn confidential_exact_fee_uses_larger_candidate_with_change() {
        let selected = select_fee_funding(
            vec![candidate(2_000, 1, true), candidate(5_000, 2, true)],
            2_000,
            1,
            1,
        )
        .expect("larger confidential candidate");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].secrets.value, 5_000);
    }

    #[test]
    fn exact_explicit_inputs_need_no_change_headroom() {
        let selected = select_fee_funding(
            vec![candidate(1_000, 1, false), candidate(1_000, 2, false)],
            2_000,
            2,
            1,
        )
        .expect("explicit exact-fee combination");
        assert_eq!(selected.len(), 2);
        assert_eq!(
            selected.iter().map(|utxo| utxo.secrets.value).sum::<u64>(),
            2_000
        );
    }
}
