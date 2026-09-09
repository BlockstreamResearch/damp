use anyhow::Context;
use damp_core::registry::SupplyMode;
use elements::Script;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::hashes::{Hash as _, sha256};
use elements::pset::{Output, PartiallySignedTransaction};
use elements::secp256k1_zkp::{Keypair, Message};

use crate::blinding;
use crate::covenant::policy::{prepare_policy, protocol_for_deployment};
use crate::covenant::program::{AnchorBranch, Protocol};
use crate::keys::WalletKeyLocator;
use crate::keys::derive::{derive_xprv, xonly_from_xprv};
use crate::keys::holder as receive;
use crate::network::DeploymentNetwork;
use crate::ops::request::ReissuanceRequest;
use crate::ops::review::OperationReview;
use crate::ops::review::SignedOperation;
use crate::ops::transfer::finish;
use crate::transaction::{
    add_validated_input, add_wallet_metadata, decode_confidential_wallet_utxo, decode_utxo,
    finalize_lwk_wallet_inputs, select_fee_funding, set_lwk_genesis_hash, wallet_address,
};
use lwk_signer::SwSigner;

pub fn reissue(
    signer: &SwSigner,
    network: DeploymentNetwork,
    request: ReissuanceRequest,
) -> anyhow::Result<SignedOperation> {
    let deployment_id = request.deployment.deployment_id();
    anyhow::ensure!(
        matches!(
            request.deployment.supply().mode(),
            SupplyMode::IssuerManaged
        ),
        "fixed-supply deployment cannot be reissued"
    );
    anyhow::ensure!(
        request.current_policy.deployment_id() == deployment_id,
        "policy deployment mismatch"
    );
    let policy_set = request.current_policy.tree();
    let policy = policy_set.commitment();
    let prepared = prepare_policy(crate::ops::request::PreparePolicyRequest {
        deployment: request.deployment.clone(),
        policy,
    })?;
    anyhow::ensure!(
        prepared.policy_root == request.current_policy.policy_root(),
        "policy digest mismatch"
    );
    anyhow::ensure!(
        &prepared.verifier_script_pubkey == request.current_policy.verifier_script_pubkey(),
        "policy script mismatch"
    );
    let validated_recipient = receive::validate_recipient_address(
        network,
        &request.deployment,
        &request.recipient_address,
    )?;
    let amount = request.amount.get();
    let own = receive::derive_holder_address(signer, network, &request.deployment)?;
    anyhow::ensure!(
        request.recipient_address == own.confidential_address,
        "reissuance must first pay the issuer own holder output"
    );
    let fee = request.fee.get();
    let verifier_asset = crate::utxo::asset_id(request.deployment.verifier_asset());
    let regulated_asset = crate::utxo::asset_id(request.deployment.regulated_asset());
    let policy_asset = crate::utxo::asset_id(request.deployment.policy_asset());
    let damp_core::registry::Supply::IssuerManaged { token, entropy } = request.deployment.supply()
    else {
        anyhow::bail!("fixed supply cannot be reissued");
    };
    let token_asset = crate::utxo::asset_id(token);
    let entropy = sha256::Midstate::from_byte_array(entropy.to_consensus_byte_array());
    let verifier = decode_utxo(signer, &request.verifier_utxo, verifier_asset)?;
    anyhow::ensure!(
        verifier.opening().value == 1,
        "verifier anchor must contain one unit"
    );
    anyhow::ensure!(
        verifier.txout.script_pubkey.as_bytes()
            == request.current_policy.verifier_script_pubkey().as_bytes(),
        "verifier UTXO script does not match current policy"
    );
    let token = decode_confidential_wallet_utxo(signer, &request.token_utxo, token_asset)?;
    anyhow::ensure!(
        token.opening().value >= 1,
        "reissuance token input is empty"
    );
    anyhow::ensure!(
        token.opening().asset_bf != elements::confidential::AssetBlindingFactor::zero(),
        "reissuance token must carry a non-zero asset blinding factor"
    );
    anyhow::ensure!(
        token.wallet_key().is_some(),
        "reissuance token needs a wallet key locator"
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
        utxo.opening().asset_bf != elements::confidential::AssetBlindingFactor::zero()
            || utxo.opening().value_bf != elements::confidential::ValueBlindingFactor::zero()
    });
    let protocol = protocol_for_deployment(&request.deployment)?;
    let anchor = protocol.anchor(policy)?;
    let (_, issuer_xprv) = derive_xprv(
        signer,
        crate::keys::KeyRole::Issuer,
        request.issuer_derivation_index,
    )?;
    anyhow::ensure!(
        xonly_from_xprv(&issuer_xprv) == request.deployment.issuer_public_key().public_key(),
        "issuer derivation does not match deployment"
    );
    let recipient = validated_recipient.address().as_address();
    let token_locator = token.wallet_key().expect("validated");
    let token_address = wallet_address(signer, request.deployment.network(), token_locator)?;

    let mut pset = PartiallySignedTransaction::new_v2();
    set_lwk_genesis_hash(&mut pset, &request.deployment)?;
    add_validated_input(&mut pset, &verifier);
    add_validated_input(&mut pset, &token);
    for utxo in &selected_fees {
        add_validated_input(&mut pset, utxo);
    }
    {
        let input = &mut pset.inputs_mut()[1];
        input.issuance_value_amount = Some(amount);
        input.issuance_blinding_nonce = Some(token.opening().asset_bf.into_inner());
        input.issuance_asset_entropy = Some(entropy.to_byte_array());
        input.blinded_issuance = Some(0);
        let (issued, returned_token) = input.issuance_ids();
        anyhow::ensure!(
            issued == regulated_asset,
            "reissuance produces the wrong regulated asset"
        );
        anyhow::ensure!(
            returned_token == token_asset,
            "reissuance expects the wrong token asset"
        );
    }
    pset.add_output(Output::new_explicit(
        anchor.script_pubkey(),
        1,
        verifier_asset,
        None,
    ));
    let mut value_only_outputs = Vec::new();
    let blind_issuance = u128::from(amount) + u128::from(fee_total) + 1
        > u128::from(crate::transaction::MAX_EXPLICIT_MONEY);
    if blind_issuance {
        let first = amount / 2;
        for value in [first, amount - first] {
            let index = pset.outputs().len();
            pset.add_output(Output::new_explicit(
                recipient.script_pubkey(),
                value,
                regulated_asset,
                recipient.blinding_pubkey.map(BitcoinPublicKey::new),
            ));
            value_only_outputs.push(index);
        }
    } else {
        pset.add_output(Output::new_explicit(
            recipient.script_pubkey(),
            amount,
            regulated_asset,
            None,
        ));
    }
    let token_output = pset.outputs().len();
    pset.add_output(Output::new_explicit(
        token_address.script_pubkey(),
        token.opening().value,
        token_asset,
        Some(BitcoinPublicKey::new(
            token_address
                .blinding_pubkey
                .context("token address is not confidential")?,
        )),
    ));
    let fee_change = fee_total - fee;
    if fee_change > 0 {
        let locator = selected_fees
            .first()
            .and_then(|utxo| utxo.wallet_key())
            .context("policy change needs a wallet key locator")?;
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

    let mut all_inputs = Vec::with_capacity(2 + selected_fees.len());
    all_inputs.push(verifier);
    all_inputs.push(token);
    all_inputs.extend(selected_fees);
    let secrets = all_inputs
        .iter()
        .enumerate()
        .map(|(index, utxo)| (index, utxo.opening()))
        .collect::<crate::blinding::secrets::InputOpenings>();
    if !value_only_outputs.is_empty() {
        blinding::blind_values(&mut pset, &secrets, &value_only_outputs)
            .context("reissuance fee-change blinding failed")?;
    }
    blinding::blind_assets_and_values(&mut pset, &secrets, &[token_output])
        .context("reissuance-token blinding failed")?;

    let environment = anchor.environment(
        &pset,
        0,
        AnchorBranch::Governance,
        protocol.config().network,
    )?;
    let message = Message::from_digest(environment.c_tx_env().sighash_all().to_byte_array());
    let issuer_keypair = Keypair::from_secret_key(
        elements::secp256k1_zkp::SECP256K1,
        &issuer_xprv.secret_key(),
    );
    let signature = elements::secp256k1_zkp::SECP256K1.sign_schnorr(&message, &issuer_keypair);
    pset.inputs_mut()[0].final_script_witness = Some(anchor.finalize(
        &pset,
        &Protocol::governance_witness(signature),
        0,
        AnchorBranch::Governance,
        protocol.config().network,
    )?);
    let mut wallet_indexes = Vec::new();
    for (index, input) in all_inputs.iter().enumerate().skip(1) {
        let locator: &WalletKeyLocator = input
            .wallet_key()
            .context("wallet input is missing its locator")?;
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
            operation: "reissuance",
            regulated_amount: amount.to_string(),
            fee: request.fee,
            input_count: all_inputs.len(),
            output_count,
            current_depth: policy.depth(),
            successor_depth: None,
            recipients: vec![request.recipient_address],
        },
    )
}
