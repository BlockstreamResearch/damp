use anyhow::Context;
use elements::Script;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};
use elements::hashes::Hash as _;
use elements::pset::{Output, PartiallySignedTransaction};
use elements::secp256k1_zkp::{Keypair, Message};

use crate::blinding;
use crate::covenant::policy::{prepare_policy, protocol_for_deployment};
use crate::covenant::program::{AnchorBranch, Protocol};
use crate::keys::WalletKeyLocator;
use crate::keys::derive::{derive_xprv, xonly_from_xprv};
use crate::network::DeploymentNetwork;
use crate::ops::request::PolicyUpdateRequest;
use crate::ops::review::OperationReview;
use crate::ops::review::SignedOperation;
use crate::ops::transfer::finish;
use crate::transaction::{
    add_validated_input, add_wallet_metadata, decode_utxo, finalize_lwk_wallet_inputs,
    select_fee_funding, set_lwk_genesis_hash, wallet_address,
};
use lwk_signer::SwSigner;

pub fn sign_policy_update(
    signer: &SwSigner,
    network: DeploymentNetwork,
    request: PolicyUpdateRequest,
) -> anyhow::Result<SignedOperation> {
    let deployment_id = request.deployment.deployment_id();
    crate::network::require_network(network, request.deployment.network())?;
    anyhow::ensure!(
        request.current_policy.deployment_id() == deployment_id,
        "current policy deployment mismatch"
    );
    anyhow::ensure!(
        request.successor_policy.deployment_id() == deployment_id,
        "successor policy deployment mismatch"
    );
    anyhow::ensure!(
        request.current_policy.sequence().checked_add(1)
            == Some(request.successor_policy.sequence()),
        "successor policy sequence must increment exactly once"
    );
    anyhow::ensure!(
        request.successor_policy.parent_policy_root() == Some(request.current_policy.policy_root()),
        "successor policy does not name the current policy as parent"
    );
    anyhow::ensure!(
        request.successor_policy.parent_verifier_script_hash()
            == Some(request.current_policy.verifier_script_hash()),
        "successor policy does not name the current verifier script as parent"
    );
    let current_set = request.current_policy.tree();
    let successor_set = request.successor_policy.tree();
    let current = current_set.commitment();
    let successor = successor_set.commitment();
    for (snapshot, commitment) in [
        (&request.current_policy, current),
        (&request.successor_policy, successor),
    ] {
        let prepared = prepare_policy(crate::ops::request::PreparePolicyRequest {
            deployment: request.deployment.clone(),
            policy: commitment,
        })?;
        anyhow::ensure!(
            prepared.policy_root == snapshot.policy_root(),
            "policy digest mismatch"
        );
        anyhow::ensure!(
            prepared.verifier_program_hash == snapshot.verifier_program_hash()
                && &prepared.verifier_script_pubkey == snapshot.verifier_script_pubkey(),
            "snapshot does not match the bundled verifier"
        );
    }
    let fee = request.fee.get();
    let verifier_asset = crate::utxo::asset_id(request.deployment.verifier_asset());
    let policy_asset = crate::utxo::asset_id(request.deployment.policy_asset());
    let verifier = decode_utxo(signer, &request.verifier_utxo, verifier_asset)?;
    anyhow::ensure!(
        verifier.opening().value == 1,
        "verifier anchor must contain exactly one unit"
    );
    anyhow::ensure!(
        verifier.txout.script_pubkey.as_bytes()
            == request.current_policy.verifier_script_pubkey().as_bytes(),
        "verifier UTXO script does not match current policy"
    );
    let fee_candidates = request
        .fee_utxos
        .iter()
        .map(|utxo| decode_utxo(signer, utxo, policy_asset))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let selected_fees = select_fee_funding(fee_candidates, fee, usize::MAX, 1)?;
    let fee_total = selected_fees.iter().try_fold(0u64, |sum, utxo| {
        sum.checked_add(utxo.opening().value)
            .context("fee amount overflow")
    })?;
    let confidential_fee_funding = selected_fees.iter().any(|utxo| {
        utxo.opening().asset_bf != AssetBlindingFactor::zero()
            || utxo.opening().value_bf != ValueBlindingFactor::zero()
    });
    let protocol = protocol_for_deployment(&request.deployment)?;
    let anchor = protocol.anchor(current)?;
    let successor_anchor = protocol.anchor(successor)?;

    let (_, issuer_xprv) = derive_xprv(
        signer,
        crate::keys::KeyRole::Issuer,
        request.issuer_derivation_index,
    )?;
    anyhow::ensure!(
        xonly_from_xprv(&issuer_xprv) == request.deployment.issuer_public_key().public_key(),
        "issuer derivation does not match deployment"
    );
    let mut pset = PartiallySignedTransaction::new_v2();
    set_lwk_genesis_hash(&mut pset, &request.deployment)?;
    add_validated_input(&mut pset, &verifier);
    for utxo in &selected_fees {
        add_validated_input(&mut pset, utxo);
    }
    pset.add_output(Output::new_explicit(
        successor_anchor.script_pubkey(),
        1,
        verifier_asset,
        None,
    ));
    let fee_change = fee_total - fee;
    let mut value_only_outputs = Vec::new();
    if fee_change > 0 {
        let locator = selected_fees
            .first()
            .and_then(|utxo| utxo.wallet_key())
            .context("policy-asset change needs a wallet key locator")?;
        let change = wallet_address(signer, request.deployment.network(), locator)?;
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
            value_only_outputs.push(index);
        }
    } else if confidential_fee_funding {
        anyhow::bail!("confidential fee funding requires policy-asset change");
    }
    pset.add_output(Output::new_explicit(Script::new(), fee, policy_asset, None));

    let mut all_inputs = Vec::with_capacity(1 + selected_fees.len());
    all_inputs.push(verifier);
    all_inputs.extend(selected_fees);
    if !value_only_outputs.is_empty() {
        let secrets = all_inputs
            .iter()
            .enumerate()
            .map(|(index, utxo)| (index, utxo.opening()))
            .collect::<crate::blinding::secrets::InputOpenings>();
        blinding::blind_values(&mut pset, &secrets, &value_only_outputs)
            .context("policy-update fee-change blinding failed")?;
    }
    let environment = anchor.environment(
        &pset,
        0,
        AnchorBranch::Governance,
        protocol.config().network,
    )?;
    let message = Message::from_digest(environment.c_tx_env().sighash_all().to_byte_array());
    let keypair = Keypair::from_secret_key(
        elements::secp256k1_zkp::SECP256K1,
        &issuer_xprv.secret_key(),
    );
    let signature = elements::secp256k1_zkp::SECP256K1.sign_schnorr(&message, &keypair);
    let witness = Protocol::governance_witness(signature);
    pset.inputs_mut()[0].final_script_witness = Some(anchor.finalize(
        &pset,
        &witness,
        0,
        AnchorBranch::Governance,
        protocol.config().network,
    )?);

    let mut wallet_indexes = Vec::new();
    for (index, input) in all_inputs.iter().enumerate().skip(1) {
        let locator: &WalletKeyLocator = input
            .wallet_key()
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
            operation: "policy-update",
            regulated_amount: "0".to_owned(),
            fee: request.fee,
            input_count: all_inputs.len(),
            output_count,
            current_depth: current.depth(),
            successor_depth: Some(successor.depth()),
            recipients: Vec::new(),
        },
    )
}
