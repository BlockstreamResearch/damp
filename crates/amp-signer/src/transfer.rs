use std::collections::HashMap;
use std::str::FromStr;

use anyhow::Context;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::hashes::Hash as _;
use elements::pset::{Output, PartiallySignedTransaction};
use elements::secp256k1_zkp::{Keypair, Message, schnorr::Signature};
use elements::{Address, AssetId, Script, TxOutSecrets};

use crate::blinding;
use crate::keys::{derive_xprv, xonly_from_xprv};
use crate::model::{
    OperationReview, SIGNER_SDK_VERSION, SignedOperation, SignerNetwork, TransferRequest,
};
use crate::policy::{
    IndexedInputPolicyProof, outpoint_key, prepare_policy, protocol_for_deployment,
};
use crate::protocol::{AnchorBranch, MAX_REGULATED_INPUTS, Protocol};
use crate::receive;
use crate::transaction::{
    ValidatedUtxo, add_validated_input, add_wallet_metadata, decode_utxo,
    finalize_lwk_wallet_inputs, parse_amount, select_fee_funding, select_smallest_sufficient,
    set_lwk_genesis_hash, wallet_address,
};
use lwk_signer::SwSigner;

pub fn sign_transfer(
    signer: &SwSigner,
    network: SignerNetwork,
    request: TransferRequest,
) -> anyhow::Result<SignedOperation> {
    let deployment_id = request.deployment.validate()?;
    anyhow::ensure!(
        request.current_policy.deployment_id == deployment_id,
        "policy deployment mismatch"
    );
    let policy_set = request.current_policy.validate()?;
    let policy = policy_set.commitment();
    let prepared = prepare_policy(crate::model::PreparePolicyRequest {
        deployment: request.deployment.clone(),
        tree_depth: policy.depth,
        set_root: hex::encode(policy.root),
        entry_count: policy.count,
    })?;
    anyhow::ensure!(
        prepared.policy_root == request.current_policy.policy_root,
        "policy digest mismatch"
    );
    anyhow::ensure!(
        prepared.verifier_program_hash == request.current_policy.verifier_program_hash
            && prepared.verifier_script_pubkey == request.current_policy.verifier_script_pubkey,
        "current snapshot does not match the bundled verifier"
    );
    receive::validate_receive_record(
        network,
        crate::model::ValidateReceiveRecordRequest {
            deployment: request.deployment.clone(),
            record: request.recipient.clone(),
        },
    )?;
    let amount = parse_amount(&request.amount, "transfer amount")?;
    let fee = parse_amount(&request.fee, "fee")?;
    let regulated_asset = AssetId::from_str(&request.deployment.regulated_asset)?;
    let verifier_asset = AssetId::from_str(&request.deployment.verifier_asset)?;
    let policy_asset = AssetId::from_str(&request.deployment.policy_asset)?;
    let verifier = decode_utxo(signer, &request.verifier_utxo, verifier_asset)?;
    anyhow::ensure!(
        verifier.secrets.value == 1,
        "verifier anchor must contain exactly one unit"
    );
    anyhow::ensure!(
        hex::encode(verifier.txout.script_pubkey.as_bytes())
            == request.current_policy.verifier_script_pubkey,
        "verifier UTXO script does not match current policy"
    );
    let regulated = request
        .regulated_utxos
        .iter()
        .map(|utxo| decode_utxo(signer, utxo, regulated_asset))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let selected_regulated = select_smallest_sufficient(regulated, amount, MAX_REGULATED_INPUTS)?;
    anyhow::ensure!(
        selected_regulated.len() <= MAX_REGULATED_INPUTS,
        "too many regulated inputs"
    );
    let regulated_total = checked_sum(&selected_regulated)?;
    let fee_candidates = request
        .fee_utxos
        .iter()
        .map(|utxo| decode_utxo(signer, utxo, policy_asset))
        .collect::<anyhow::Result<Vec<_>>>()?;
    // The verifier budget is measured for one ordinary policy-asset input in
    // addition to the anchor and regulated inputs. Requiring one sufficiently
    // large fee UTXO keeps the transaction shape deterministic.
    let selected_fees = select_fee_funding(fee_candidates, fee, 1, 1)?;
    let fee_total = checked_sum(&selected_fees)?;
    let confidential_fee_funding = selected_fees.iter().any(|utxo| {
        utxo.secrets.asset_bf != elements::confidential::AssetBlindingFactor::zero()
            || utxo.secrets.value_bf != elements::confidential::ValueBlindingFactor::zero()
    });

    let protocol = protocol_for_deployment(&request.deployment)?;
    let anchor = protocol.anchor(policy)?;
    let sender = validate_holder_inputs(signer, &protocol, &selected_regulated)?;
    let recipient_owner =
        elements::schnorr::XOnlyPublicKey::from_str(&request.recipient.owner_public_key)?;
    let recipient_address = Address::from_str(&request.recipient.confidential_address)?;
    anyhow::ensure!(
        recipient_address.blinding_pubkey.is_some(),
        "recipient address is not confidential"
    );

    let mut pset = PartiallySignedTransaction::new_v2();
    set_lwk_genesis_hash(&mut pset, &request.deployment)?;
    add_validated_input(&mut pset, &verifier);
    for utxo in &selected_regulated {
        add_validated_input(&mut pset, utxo);
    }
    let first_fee_index = pset.inputs().len();
    for utxo in &selected_fees {
        add_validated_input(&mut pset, utxo);
    }

    pset.add_output(Output::new_explicit(
        anchor.script_pubkey(),
        1,
        verifier_asset,
        None,
    ));
    let mut value_blinded_outputs = Vec::new();
    pset.add_output(Output::new_explicit(
        recipient_address.script_pubkey(),
        amount,
        regulated_asset,
        None,
    ));

    let regulated_change = regulated_total - amount;
    let mut recipients = vec![recipient_owner];
    if regulated_change > 0 {
        let holder_script = protocol.user_script(sender.0)?;
        pset.add_output(Output::new_explicit(
            holder_script,
            regulated_change,
            regulated_asset,
            None,
        ));
        recipients.push(sender.0);
    }
    let fee_change = fee_total - fee;
    if fee_change > 0 {
        let locator = selected_fees
            .first()
            .and_then(|utxo| utxo.wallet_key.as_ref())
            .context("policy-asset change needs a wallet key locator")?;
        let change = wallet_address(signer, &request.deployment, locator)?;
        let index = pset.outputs().len();
        pset.add_output(Output::new_explicit(
            change.script_pubkey(),
            fee_change,
            policy_asset,
            confidential_fee_funding
                .then(|| {
                    change
                        .blinding_pubkey
                        .context("policy-asset change address is not confidential")
                        .map(BitcoinPublicKey::new)
                })
                .transpose()?,
        ));
        if confidential_fee_funding {
            value_blinded_outputs.push(index);
        }
    } else if confidential_fee_funding {
        anyhow::bail!("confidential fee funding requires policy-asset change");
    }
    pset.add_output(Output::new_explicit(Script::new(), fee, policy_asset, None));
    anyhow::ensure!(recipients.len() <= 10, "too many regulated outputs");

    let mut all_inputs = Vec::with_capacity(pset.inputs().len());
    all_inputs.push(verifier);
    all_inputs.extend(selected_regulated);
    all_inputs.extend(selected_fees);
    let input_secrets = all_inputs
        .iter()
        .enumerate()
        .map(|(index, utxo)| (index, utxo.secrets))
        .collect::<HashMap<usize, TxOutSecrets>>();
    if !value_blinded_outputs.is_empty() {
        blinding::blind_values(&mut pset, &input_secrets, &value_blinded_outputs)
            .context("transfer fee-change blinding failed")?;
    }

    let proofs = all_inputs[1..first_fee_index]
        .iter()
        .enumerate()
        .map(|(offset, utxo)| {
            Ok(IndexedInputPolicyProof::new(
                u32::try_from(offset + 1)?,
                policy_set.non_membership_proof(outpoint_key(utxo.outpoint))?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut recipient_slots = [None; 10];
    for (slot, recipient) in recipient_slots.iter_mut().zip(recipients.iter().copied()) {
        *slot = Some(recipient);
    }
    let verifier_witness = Protocol::transfer_witness(policy, sender.0, recipient_slots, &proofs)?;
    let verifier_stack = anchor.finalize(
        &pset,
        &verifier_witness,
        0,
        AnchorBranch::Verifier,
        protocol.config().network,
    )?;
    pset.inputs_mut()[0].final_script_witness = Some(verifier_stack);

    for (index, input) in all_inputs.iter().enumerate().take(first_fee_index).skip(1) {
        let holder = input
            .holder_key
            .as_ref()
            .context("regulated input is missing its holder locator")?;
        let (_, xprv) = derive_xprv(signer, "holder", holder.derivation_index)?;
        let owner = xonly_from_xprv(&xprv);
        let program = protocol.user_program(owner)?;
        let environment = program.environment(&pset, index, protocol.config().network)?;
        let message = Message::from_digest(environment.c_tx_env().sighash_all().to_byte_array());
        let keypair =
            Keypair::from_secret_key(elements::secp256k1_zkp::SECP256K1, &xprv.private_key);
        let signature: Signature =
            elements::secp256k1_zkp::SECP256K1.sign_schnorr(&message, &keypair);
        pset.inputs_mut()[index].final_script_witness =
            Some(protocol.finalize_user(&pset, owner, signature, index)?);
    }

    let mut wallet_indexes = Vec::new();
    for (index, input) in all_inputs.iter().enumerate().skip(first_fee_index) {
        let locator = input
            .wallet_key
            .as_ref()
            .context("fee input is missing its wallet locator")?;
        add_wallet_metadata(
            signer,
            &mut pset,
            index,
            locator,
            &input.txout.script_pubkey,
        )?;
        wallet_indexes.push(index);
    }
    finalize_lwk_wallet_inputs(signer, &mut pset, &wallet_indexes)?;
    let output_count = pset.outputs().len();
    finish(
        pset,
        OperationReview {
            deployment_id,
            operation: "transfer",
            regulated_amount: amount.to_string(),
            fee: fee.to_string(),
            input_count: all_inputs.len(),
            output_count,
            current_depth: policy.depth,
            successor_depth: None,
            recipients: vec![request.recipient.alias],
        },
    )
}

fn validate_holder_inputs(
    signer: &SwSigner,
    protocol: &Protocol,
    inputs: &[ValidatedUtxo],
) -> anyhow::Result<(elements::schnorr::XOnlyPublicKey, u32)> {
    let first = inputs.first().context("no regulated input selected")?;
    let first_locator = first
        .holder_key
        .as_ref()
        .context("regulated input is missing its holder locator")?;
    for input in inputs {
        let locator = input
            .holder_key
            .as_ref()
            .context("regulated input is missing its holder locator")?;
        let (_, xprv) = derive_xprv(signer, "holder", locator.derivation_index)?;
        let owner = xonly_from_xprv(&xprv);
        anyhow::ensure!(
            owner.to_string() == locator.owner_public_key,
            "holder locator key mismatch"
        );
        anyhow::ensure!(
            protocol.user_script(owner)? == input.txout.script_pubkey,
            "regulated input does not use its derived holder covenant"
        );
    }
    let (_, xprv) = derive_xprv(signer, "holder", first_locator.derivation_index)?;
    Ok((xonly_from_xprv(&xprv), first_locator.derivation_index))
}

fn checked_sum(values: &[ValidatedUtxo]) -> anyhow::Result<u64> {
    values.iter().try_fold(0u64, |sum, value| {
        sum.checked_add(value.secrets.value)
            .context("selected input amount overflow")
    })
}

pub fn finish(
    pset: PartiallySignedTransaction,
    review: OperationReview,
) -> anyhow::Result<SignedOperation> {
    let spent_utxos = pset
        .inputs()
        .iter()
        .enumerate()
        .map(|(index, input)| {
            input
                .witness_utxo
                .clone()
                .with_context(|| format!("input {index} is missing its spent output"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let transaction = pset.extract_tx()?;
    crate::transaction::verify_transaction_amounts(&transaction, &spent_utxos)
        .with_context(|| format!("{} transaction proof validation failed", review.operation))?;
    Ok(SignedOperation {
        sdk: SIGNER_SDK_VERSION,
        operation: review.operation,
        pset: pset.to_string(),
        transaction: elements::encode::serialize_hex(&transaction),
        txid: transaction.txid().to_string(),
        review,
    })
}
