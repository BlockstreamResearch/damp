use anyhow::Context;

use simplicity_amp::policy::{IndexedInputPolicyProof, PolicySet, TreeDepth, outpoint_key};
use simplicity_amp::protocol::{AnchorBranch, Protocol, ProtocolConfig};

use simplex::signer::SignerTrait;
use simplex::simplicityhl::elements::confidential::{
    Asset, AssetBlindingFactor, Value, ValueBlindingFactor,
};
use simplex::simplicityhl::elements::hashes::Hash;
use simplex::simplicityhl::elements::pset::{Output, PartiallySignedTransaction};
use simplex::simplicityhl::elements::schnorr::Keypair;
use simplex::simplicityhl::elements::secp256k1_zkp::rand::thread_rng;
use simplex::simplicityhl::elements::secp256k1_zkp::{Message, SECP256K1, SecretKey};
use simplex::simplicityhl::elements::{
    AssetId, EcdsaSighashType, RangeProofMessage, Script, Transaction, TxOut, TxOutWitness, Txid,
};
use simplex::transaction::partial_input::IssuanceInput;
use simplex::transaction::{
    FinalTransaction, PartialInput, PartialOutput, RequiredSignature, UTXO,
};

const REGULATED_AMOUNT: u64 = 1_000;
const TRANSFER_AMOUNT: u64 = 100;
const CHANGE_AMOUNT: u64 = REGULATED_AMOUNT - TRANSFER_AMOUNT;
const VERIFIER_AMOUNT: u64 = 1;
const FEE_AMOUNT: u64 = 25_000;

#[simplex::test]
fn broadcast_policy_checked_transfer(context: simplex::TestContext) -> anyhow::Result<()> {
    let signer = context.get_default_signer();
    let provider = context.get_default_provider();
    let network = *context.get_network();
    let owner = signer.get_schnorr_public_key();

    let regulated_asset = issue_asset(&context, REGULATED_AMOUNT, [0xa1; 32])?;
    let verifier_asset = issue_asset(&context, VERIFIER_AMOUNT, [0xb2; 32])?;
    let protocol = Protocol::new(ProtocolConfig {
        regulated_asset,
        verifier_asset,
        verifier_asset_amount: VERIFIER_AMOUNT,
        issuer: owner,
        network,
    })?;

    // Fund the user first so the blacklist proof binds the actual spent outpoint.
    let owner_script = protocol.user_script(owner);
    let user_utxo = fund_asset_script(&context, regulated_asset, REGULATED_AMOUNT, &owner_script)?;
    // The spent key lies strictly between these sentinels, exercising both
    // authenticated neighbors in the depth-4 non-membership proof.
    let blacklist = PolicySet::new(TreeDepth::D4, [[0; 32], [0xff; 32]])?;
    let policy = blacklist.commitment();

    let verifier_script = protocol.verifier_script(policy)?;
    let verifier_utxo =
        fund_asset_script(&context, verifier_asset, VERIFIER_AMOUNT, &verifier_script)?;
    let fee_utxo = fund_policy_utxo(&context, FEE_AMOUNT)?;

    let recipient = context.random_signer();
    let recipient_key = recipient.get_schnorr_public_key();
    let recipient_script = protocol.user_script(recipient_key);
    let input_proof = blacklist.non_membership_proof(outpoint_key(user_utxo.outpoint))?;
    let verifier_witness = Protocol::transfer_witness(
        policy,
        owner,
        recipient_slots(&[recipient_key, owner]),
        &[IndexedInputPolicyProof::new(1, input_proof)],
    )?;

    let verifier_anchor = protocol.anchor(policy)?;
    let user_program = protocol.user_program(owner);
    let mut pst = PartiallySignedTransaction::new_v2();
    pst.add_input(PartialInput::new(verifier_utxo).to_input());
    pst.add_input(PartialInput::new(user_utxo).to_input());
    pst.add_input(PartialInput::new(fee_utxo).to_input());
    pst.add_output(Output::new_explicit(
        verifier_script.clone(),
        VERIFIER_AMOUNT,
        verifier_asset,
        None,
    ));
    pst.add_output(Output::new_explicit(
        recipient_script.clone(),
        TRANSFER_AMOUNT,
        regulated_asset,
        None,
    ));
    pst.add_output(Output::from_txout(confidential_value_output(
        owner_script.clone(),
        regulated_asset,
        CHANGE_AMOUNT,
        signer,
    )?));
    pst.add_output(Output::new_explicit(
        Script::new(),
        FEE_AMOUNT,
        network.policy_asset(),
        None,
    ));

    let verifier_final = verifier_anchor
        .finalize(&pst, &verifier_witness, 0, AnchorBranch::Verifier, &network)
        .context("finalize verifier input")?;
    pst.inputs_mut()[0].final_script_witness = Some(verifier_final);

    let owner_signature = signer.sign_program(&pst, user_program.as_ref(), 1, &network)?;
    let user_final = protocol
        .finalize_user(&pst, owner, owner_signature, 1, &network)
        .context("finalize user input")?;
    pst.inputs_mut()[1].final_script_witness = Some(user_final);

    let (public_key, signature) = signer.sign_input(&pst, 2)?;
    let mut raw_signature = signature.serialize_der().to_vec();
    raw_signature.push(EcdsaSighashType::All as u8);
    pst.inputs_mut()[2].final_script_witness = Some(vec![raw_signature, public_key.to_bytes()]);

    let transaction = pst.extract_tx()?;
    let receipt = provider.broadcast_transaction(&transaction)?;
    receipt.wait()?;
    let fetched = provider.fetch_transaction(&receipt.txid())?;

    assert_transfer_shape(
        &fetched,
        &verifier_script,
        &recipient_script,
        &owner_script,
        verifier_asset,
        regulated_asset,
        network.policy_asset(),
    );
    Ok(())
}

#[simplex::test]
fn blacklisted_input_is_rejected_before_broadcast(
    context: simplex::TestContext,
) -> anyhow::Result<()> {
    let signer = context.get_default_signer();
    let network = *context.get_network();
    let owner = signer.get_schnorr_public_key();

    let regulated_asset = issue_asset(&context, REGULATED_AMOUNT, [0xe5; 32])?;
    let verifier_asset = issue_asset(&context, VERIFIER_AMOUNT, [0xf6; 32])?;
    let protocol = Protocol::new(ProtocolConfig {
        regulated_asset,
        verifier_asset,
        verifier_asset_amount: VERIFIER_AMOUNT,
        issuer: owner,
        network,
    })?;
    let owner_script = protocol.user_script(owner);
    let user_utxo = fund_asset_script(&context, regulated_asset, REGULATED_AMOUNT, &owner_script)?;
    let blocked_key = outpoint_key(user_utxo.outpoint);
    let blacklist = PolicySet::new(TreeDepth::D4, [blocked_key])?;
    let policy = blacklist.commitment();
    let anchor = protocol.anchor(policy)?;
    let verifier_utxo = fund_asset_script(
        &context,
        verifier_asset,
        VERIFIER_AMOUNT,
        &anchor.script_pubkey(),
    )?;

    let mut transfer = PartiallySignedTransaction::new_v2();
    transfer.add_input(PartialInput::new(verifier_utxo).to_input());
    transfer.add_input(PartialInput::new(user_utxo).to_input());
    transfer.add_output(Output::new_explicit(
        anchor.script_pubkey(),
        VERIFIER_AMOUNT,
        verifier_asset,
        None,
    ));
    transfer.add_output(Output::new_explicit(
        owner_script,
        REGULATED_AMOUNT,
        regulated_asset,
        None,
    ));

    // A proof generated against an empty tree cannot authenticate against the
    // live root containing this exact outpoint. Execution must fail before a
    // transaction can be signed or submitted to the node.
    let fake_allowed_tree = PolicySet::new(TreeDepth::D4, [])?;
    let fake_proof = fake_allowed_tree.non_membership_proof(blocked_key)?;
    let witness = Protocol::transfer_witness(
        policy,
        owner,
        recipient_slots(&[owner]),
        &[IndexedInputPolicyProof::new(1, fake_proof)],
    )?;
    assert!(
        anchor
            .execute(&transfer, &witness, 0, AnchorBranch::Verifier, &network,)
            .is_err()
    );
    Ok(())
}

#[simplex::test]
fn governance_upgrade_then_d5_transfer(context: simplex::TestContext) -> anyhow::Result<()> {
    let signer = context.get_default_signer();
    let provider = context.get_default_provider();
    let network = *context.get_network();
    let owner = signer.get_schnorr_public_key();
    let issuer = Keypair::from_secret_key(SECP256K1, &SecretKey::from_slice(&[0x41; 32])?);

    let regulated_asset = issue_asset(&context, REGULATED_AMOUNT, [0xc3; 32])?;
    let verifier_asset = issue_asset(&context, VERIFIER_AMOUNT, [0xd4; 32])?;
    let protocol = Protocol::new(ProtocolConfig {
        regulated_asset,
        verifier_asset,
        verifier_asset_amount: VERIFIER_AMOUNT,
        issuer: issuer.x_only_public_key().0,
        network,
    })?;
    let owner_script = protocol.user_script(owner);
    let user_utxo = fund_asset_script(&context, regulated_asset, REGULATED_AMOUNT, &owner_script)?;

    let d4_policy = PolicySet::new(TreeDepth::D4, [])?.commitment();
    let d5_blacklist = PolicySet::new(TreeDepth::D5, [[0; 32], [0xff; 32]])?;
    let d5_policy = d5_blacklist.commitment();
    let d4_anchor = protocol.anchor(d4_policy)?;
    let d5_anchor = protocol.anchor(d5_policy)?;
    let d4_utxo = fund_asset_script(
        &context,
        verifier_asset,
        VERIFIER_AMOUNT,
        &d4_anchor.script_pubkey(),
    )?;
    let update_fee = fund_policy_utxo(&context, FEE_AMOUNT)?;

    let mut update = PartiallySignedTransaction::new_v2();
    update.add_input(PartialInput::new(d4_utxo).to_input());
    update.add_input(PartialInput::new(update_fee).to_input());
    update.add_output(Output::new_explicit(
        d5_anchor.script_pubkey(),
        VERIFIER_AMOUNT,
        verifier_asset,
        None,
    ));
    update.add_output(Output::new_explicit(
        Script::new(),
        FEE_AMOUNT,
        network.policy_asset(),
        None,
    ));
    let environment = d4_anchor.environment(&update, 0, AnchorBranch::Governance, &network)?;
    let message = Message::from_digest(environment.c_tx_env().sighash_all().to_byte_array());
    let issuer_signature = SECP256K1.sign_schnorr(&message, &issuer);
    update.inputs_mut()[0].final_script_witness = Some(d4_anchor.finalize(
        &update,
        &Protocol::governance_witness(issuer_signature),
        0,
        AnchorBranch::Governance,
        &network,
    )?);
    finalize_native_input(signer, &mut update, 1)?;
    let update_tx = update.extract_tx()?;
    let update_receipt = provider.broadcast_transaction(&update_tx)?;
    update_receipt.wait()?;
    let d5_utxo = find_funded_utxo(
        provider,
        &d5_anchor.script_pubkey(),
        update_receipt.txid(),
        verifier_asset,
        VERIFIER_AMOUNT,
    )?;

    let transfer_fee = fund_policy_utxo(&context, FEE_AMOUNT)?;
    let recipient = context.random_signer();
    let recipient_key = recipient.get_schnorr_public_key();
    let recipient_script = protocol.user_script(recipient_key);
    let proof = IndexedInputPolicyProof::new(
        1,
        d5_blacklist.non_membership_proof(outpoint_key(user_utxo.outpoint))?,
    );
    let verifier_witness = Protocol::transfer_witness(
        d5_policy,
        owner,
        recipient_slots(&[recipient_key, owner]),
        &[proof],
    )?;

    let mut transfer = PartiallySignedTransaction::new_v2();
    transfer.add_input(PartialInput::new(d5_utxo).to_input());
    transfer.add_input(PartialInput::new(user_utxo).to_input());
    transfer.add_input(PartialInput::new(transfer_fee).to_input());
    transfer.add_output(Output::new_explicit(
        d5_anchor.script_pubkey(),
        VERIFIER_AMOUNT,
        verifier_asset,
        None,
    ));
    transfer.add_output(Output::new_explicit(
        recipient_script.clone(),
        TRANSFER_AMOUNT,
        regulated_asset,
        None,
    ));
    transfer.add_output(Output::new_explicit(
        owner_script,
        CHANGE_AMOUNT,
        regulated_asset,
        None,
    ));
    transfer.add_output(Output::new_explicit(
        Script::new(),
        FEE_AMOUNT,
        network.policy_asset(),
        None,
    ));
    transfer.inputs_mut()[0].final_script_witness = Some(d5_anchor.finalize(
        &transfer,
        &verifier_witness,
        0,
        AnchorBranch::Verifier,
        &network,
    )?);
    let owner_signature = signer.sign_program(
        &transfer,
        protocol.user_program(owner).as_ref(),
        1,
        &network,
    )?;
    transfer.inputs_mut()[1].final_script_witness =
        Some(protocol.finalize_user(&transfer, owner, owner_signature, 1, &network)?);
    finalize_native_input(signer, &mut transfer, 2)?;
    let transfer_tx = transfer.extract_tx()?;
    let receipt = provider.broadcast_transaction(&transfer_tx)?;
    receipt.wait()?;
    let fetched = provider.fetch_transaction(&receipt.txid())?;
    assert_eq!(fetched.output[0].script_pubkey, d5_anchor.script_pubkey());
    assert_eq!(fetched.output[1].script_pubkey, recipient_script);
    Ok(())
}

fn finalize_native_input(
    signer: &simplex::signer::Signer,
    pset: &mut PartiallySignedTransaction,
    input_index: usize,
) -> anyhow::Result<()> {
    let (public_key, signature) = signer.sign_input(pset, input_index)?;
    let mut raw_signature = signature.serialize_der().to_vec();
    raw_signature.push(EcdsaSighashType::All as u8);
    pset.inputs_mut()[input_index].final_script_witness =
        Some(vec![raw_signature, public_key.to_bytes()]);
    Ok(())
}

fn issue_asset(
    context: &simplex::TestContext,
    amount: u64,
    entropy: [u8; 32],
) -> anyhow::Result<AssetId> {
    let signer = context.get_default_signer();
    let policy_asset = context.get_network().policy_asset();
    let funding = signer
        .get_utxos_asset(policy_asset)?
        .into_iter()
        .next()
        .context("missing policy-asset issuance input")?;
    let mut transaction = FinalTransaction::new();
    let issuance = transaction.add_issuance_input(
        PartialInput::new(funding),
        IssuanceInput::new_issuance(amount, 0, entropy),
        RequiredSignature::NativeEcdsa,
    );
    transaction.add_output(PartialOutput::new(
        signer.get_address().script_pubkey(),
        amount,
        issuance.asset_id,
    ));
    signer.broadcast(&transaction)?.wait()?;
    Ok(issuance.asset_id)
}

fn fund_asset_script(
    context: &simplex::TestContext,
    asset: AssetId,
    amount: u64,
    script: &Script,
) -> anyhow::Result<UTXO> {
    let signer = context.get_default_signer();
    let provider = context.get_default_provider();
    let source = signer
        .get_utxos_asset(asset)?
        .into_iter()
        .find(|utxo| utxo.amount() >= amount)
        .context("missing issued asset UTXO")?;
    let source_amount = source.amount();
    let mut transaction = FinalTransaction::new();
    transaction.add_input(PartialInput::new(source), RequiredSignature::NativeEcdsa);
    transaction.add_output(PartialOutput::new(script.clone(), amount, asset));
    if source_amount > amount {
        transaction.add_output(PartialOutput::new(
            signer.get_address().script_pubkey(),
            source_amount - amount,
            asset,
        ));
    }
    let receipt = signer.broadcast(&transaction)?;
    receipt.wait()?;
    find_funded_utxo(provider, script, receipt.txid(), asset, amount)
}

fn fund_policy_utxo(context: &simplex::TestContext, amount: u64) -> anyhow::Result<UTXO> {
    let signer = context.get_default_signer();
    let provider = context.get_default_provider();
    let script = signer.get_address().script_pubkey();
    let receipt = signer.send(script.clone(), amount)?;
    receipt.wait()?;
    find_funded_utxo(
        provider,
        &script,
        receipt.txid(),
        context.get_network().policy_asset(),
        amount,
    )
}

fn find_funded_utxo(
    provider: &dyn simplex::provider::ProviderTrait,
    script: &Script,
    txid: Txid,
    asset: AssetId,
    amount: u64,
) -> anyhow::Result<UTXO> {
    provider
        .fetch_scripthash_utxos(script)?
        .into_iter()
        .find(|utxo| {
            utxo.outpoint.txid == txid
                && utxo.txout.asset.explicit() == Some(asset)
                && utxo.txout.value.explicit() == Some(amount)
        })
        .with_context(|| format!("missing funded UTXO {txid}:{asset}:{amount}"))
}

fn confidential_value_output(
    script: Script,
    asset: AssetId,
    amount: u64,
    recipient: &simplex::signer::Signer,
) -> anyhow::Result<TxOut> {
    let mut rng = thread_rng();
    let (value, nonce, rangeproof) = Value::Explicit(amount).blind(
        SECP256K1,
        ValueBlindingFactor::zero(),
        recipient.get_blinding_public_key().inner,
        SecretKey::new(&mut rng),
        &script,
        &RangeProofMessage {
            asset,
            bf: AssetBlindingFactor::zero(),
        },
    )?;
    Ok(TxOut {
        asset: Asset::Explicit(asset),
        value,
        nonce,
        script_pubkey: script,
        witness: TxOutWitness {
            surjection_proof: None,
            rangeproof: Some(Box::new(rangeproof)),
        },
    })
}

fn recipient_slots(
    recipients: &[simplex::simplicityhl::elements::schnorr::XOnlyPublicKey],
) -> [Option<simplex::simplicityhl::elements::schnorr::XOnlyPublicKey>; 10] {
    let mut slots = [None; 10];
    for (slot, recipient) in slots.iter_mut().zip(recipients) {
        *slot = Some(*recipient);
    }
    slots
}

fn assert_transfer_shape(
    transaction: &Transaction,
    verifier_script: &Script,
    recipient_script: &Script,
    owner_script: &Script,
    verifier_asset: AssetId,
    regulated_asset: AssetId,
    policy_asset: AssetId,
) {
    assert_eq!(transaction.input.len(), 3);
    assert_eq!(transaction.output.len(), 4);

    let anchor = &transaction.output[0];
    assert_eq!(anchor.script_pubkey, *verifier_script);
    assert_eq!(anchor.asset.explicit(), Some(verifier_asset));
    assert_eq!(anchor.value.explicit(), Some(VERIFIER_AMOUNT));

    let recipient = &transaction.output[1];
    assert_eq!(recipient.script_pubkey, *recipient_script);
    assert_eq!(recipient.asset.explicit(), Some(regulated_asset));
    assert_eq!(recipient.value.explicit(), Some(TRANSFER_AMOUNT));

    let change = &transaction.output[2];
    assert_eq!(change.script_pubkey, *owner_script);
    assert_eq!(change.asset.explicit(), Some(regulated_asset));
    assert!(change.value.is_confidential());
    assert!(change.witness.rangeproof.is_some());

    let fee = &transaction.output[3];
    assert!(fee.is_fee());
    assert_eq!(fee.asset.explicit(), Some(policy_asset));
    assert_eq!(fee.value.explicit(), Some(FEE_AMOUNT));
}
