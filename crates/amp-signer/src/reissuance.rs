use std::collections::HashMap;
use std::str::FromStr;

use amp_core::registry::SupplyMode;
use anyhow::Context;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::hashes::{Hash as _, sha256};
use elements::pset::{Output, PartiallySignedTransaction};
use elements::secp256k1_zkp::{Keypair, Message};
use elements::{Address, AssetId, Script, TxOutSecrets};

use crate::blinding;
use crate::keys::{derive_xprv, xonly_from_xprv};
use crate::model::{
    OperationReview, ReissuanceRequest, SignedOperation, SignerNetwork, WalletKeyLocator,
};
use crate::policy::{prepare_policy, protocol_for_deployment};
use crate::protocol::{AnchorBranch, Protocol};
use crate::receive;
use crate::transaction::{
    add_validated_input, add_wallet_metadata, decode_confidential_wallet_utxo, decode_utxo,
    finalize_lwk_wallet_inputs, parse_amount, select_fee_funding, set_lwk_genesis_hash,
    wallet_address,
};
use crate::transfer::finish;
use lwk_signer::SwSigner;

pub fn reissue(
    signer: &SwSigner,
    network: SignerNetwork,
    request: ReissuanceRequest,
) -> anyhow::Result<SignedOperation> {
    let deployment_id = request.deployment.validate()?;
    anyhow::ensure!(
        matches!(request.deployment.supply_mode, SupplyMode::IssuerManaged),
        "fixed-supply deployment cannot be reissued"
    );
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
        prepared.verifier_script_pubkey == request.current_policy.verifier_script_pubkey,
        "policy script mismatch"
    );
    receive::validate_receive_record(
        network,
        crate::model::ValidateReceiveRecordRequest {
            deployment: request.deployment.clone(),
            record: request.recipient.clone(),
        },
    )?;
    let amount = parse_amount(&request.amount, "reissuance amount")?;
    let fee = parse_amount(&request.fee, "fee")?;
    let verifier_asset = AssetId::from_str(&request.deployment.verifier_asset)?;
    let regulated_asset = AssetId::from_str(&request.deployment.regulated_asset)?;
    let policy_asset = AssetId::from_str(&request.deployment.policy_asset)?;
    let token_asset = AssetId::from_str(
        request
            .deployment
            .reissuance_token
            .as_deref()
            .context("managed deployment has no reissuance token")?,
    )?;
    let entropy = sha256::Midstate::from_str(
        request
            .deployment
            .reissuance_entropy
            .as_deref()
            .context("managed deployment has no reissuance entropy")?,
    )?;
    let verifier = decode_utxo(signer, &request.verifier_utxo, verifier_asset)?;
    anyhow::ensure!(
        verifier.secrets.value == 1,
        "verifier anchor must contain one unit"
    );
    anyhow::ensure!(
        hex::encode(verifier.txout.script_pubkey.as_bytes())
            == request.current_policy.verifier_script_pubkey,
        "verifier UTXO script does not match current policy"
    );
    let token = decode_confidential_wallet_utxo(signer, &request.token_utxo, token_asset)?;
    anyhow::ensure!(token.secrets.value >= 1, "reissuance token input is empty");
    anyhow::ensure!(
        token.secrets.asset_bf != elements::confidential::AssetBlindingFactor::zero(),
        "reissuance token must carry a non-zero asset blinding factor"
    );
    anyhow::ensure!(
        token.wallet_key.is_some(),
        "reissuance token needs a wallet key locator"
    );
    let fee_candidates = request
        .fee_utxos
        .iter()
        .map(|utxo| decode_utxo(signer, utxo, policy_asset))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let selected_fees = select_fee_funding(fee_candidates, fee, usize::MAX, 1)?;
    let fee_total = selected_fees.iter().try_fold(0u64, |sum, utxo| {
        sum.checked_add(utxo.secrets.value)
            .context("fee amount overflow")
    })?;
    let confidential_fee_funding = selected_fees.iter().any(|utxo| {
        utxo.secrets.asset_bf != elements::confidential::AssetBlindingFactor::zero()
            || utxo.secrets.value_bf != elements::confidential::ValueBlindingFactor::zero()
    });
    let protocol = protocol_for_deployment(&request.deployment)?;
    let anchor = protocol.anchor(policy)?;
    let (_, issuer_xprv) = derive_xprv(signer, "issuer", request.issuer_derivation_index)?;
    anyhow::ensure!(
        xonly_from_xprv(&issuer_xprv).to_string() == request.deployment.issuer_public_key,
        "issuer derivation does not match deployment"
    );
    let recipient = Address::from_str(&request.recipient.confidential_address)?;
    anyhow::ensure!(
        recipient.blinding_pubkey.is_some(),
        "recipient is not confidential"
    );
    let token_locator = token.wallet_key.as_ref().expect("validated");
    let token_address = wallet_address(signer, &request.deployment, token_locator)?;

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
        input.issuance_blinding_nonce = Some(token.secrets.asset_bf.into_inner());
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
    if amount > 1 {
        for value in [amount - 1, 1] {
            pset.add_output(Output::new_explicit(
                recipient.script_pubkey(),
                value,
                regulated_asset,
                None,
            ));
        }
    } else {
        pset.add_output(Output::new_explicit(
            recipient.script_pubkey(),
            1,
            regulated_asset,
            None,
        ));
    }
    let token_output = pset.outputs().len();
    pset.add_output(Output::new_explicit(
        token_address.script_pubkey(),
        token.secrets.value,
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
            .and_then(|utxo| utxo.wallet_key.as_ref())
            .context("policy change needs a wallet key locator")?;
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
        .map(|(index, utxo)| (index, utxo.secrets))
        .collect::<HashMap<usize, TxOutSecrets>>();
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
    let issuer_keypair =
        Keypair::from_secret_key(elements::secp256k1_zkp::SECP256K1, &issuer_xprv.private_key);
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
            .wallet_key
            .as_ref()
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
            fee: fee.to_string(),
            input_count: all_inputs.len(),
            output_count,
            current_depth: policy.depth,
            successor_depth: None,
            recipients: vec![request.recipient.alias],
        },
    )
}
