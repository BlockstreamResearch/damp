use std::collections::HashMap;
use std::str::FromStr;

use amp_core::policy::{PolicySet, TreeDepth};
use amp_core::registry::{
    DeploymentManifestV1, PROTOCOL_ID_V1, PolicySnapshotV1, REGISTRY_SCHEMA_V1, SupplyMode,
};
use anyhow::Context;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::hashes::Hash as _;
use elements::issuance::ContractHash;
use elements::pset::{Output, PartiallySignedTransaction};
use elements::{AssetId, Script, TxOutSecrets};

use crate::blinding;
use crate::keys::{blinding_public_key, derive_key_index, derive_xprv, xonly_from_xprv};
use crate::model::{
    BootstrapRequest, BootstrapResult, CreateReceiveRecordRequest, OperationReview,
    SIGNER_SDK_VERSION, SignerNetwork,
};
use crate::protocol::{Protocol, ProtocolConfig};
use crate::receive;
use crate::transaction::{
    add_validated_input, add_wallet_metadata, decode_utxo, finalize_lwk_wallet_inputs,
    parse_amount, set_lwk_genesis_hash, wallet_address,
};
use lwk_signer::SwSigner;

pub fn bootstrap(
    signer: &SwSigner,
    network: SignerNetwork,
    request: BootstrapRequest,
) -> anyhow::Result<BootstrapResult> {
    anyhow::ensure!(
        matches!(
            (network, request.network),
            (
                SignerNetwork::LiquidTestnet,
                amp_core::registry::DeploymentNetwork::LiquidTestnet
            ) | (
                SignerNetwork::ElementsRegtest,
                amp_core::registry::DeploymentNetwork::ElementsRegtest
            )
        ),
        "signer network does not match bootstrap network"
    );
    anyhow::ensure!(
        request.required_confirmations > 0,
        "at least one confirmation is required"
    );
    let supply = parse_amount(&request.issued_supply, "issued supply")?;
    let fee = parse_amount(&request.fee, "fee")?;
    let policy_asset = AssetId::from_str(&request.policy_asset)?;
    let mut candidates = request
        .policy_utxos
        .iter()
        .map(|utxo| decode_utxo(signer, utxo, policy_asset))
        .collect::<anyhow::Result<Vec<_>>>()?;
    candidates.sort_by(|left, right| {
        left.secrets
            .value
            .cmp(&right.secrets.value)
            .then_with(|| left.outpoint.txid.cmp(&right.outpoint.txid))
            .then_with(|| left.outpoint.vout.cmp(&right.outpoint.vout))
    });
    anyhow::ensure!(
        candidates.len() >= 2,
        "bootstrap requires two distinct issuance inputs"
    );
    let mut selected = Vec::new();
    let mut policy_total = 0u64;
    for candidate in candidates {
        policy_total = policy_total
            .checked_add(candidate.secrets.value)
            .context("policy input amount overflow")?;
        selected.push(candidate);
        if selected.len() >= 2 && policy_total >= fee {
            break;
        }
    }
    anyhow::ensure!(
        selected.len() >= 2 && policy_total >= fee,
        "insufficient policy asset"
    );
    for utxo in &selected {
        anyhow::ensure!(
            utxo.wallet_key.is_some(),
            "bootstrap inputs need wallet key locators"
        );
    }

    let issuer_index = derive_key_index(&request.deployment_salt, "issuer")?;
    let holder_index = derive_key_index(&request.deployment_salt, "holder")?;
    let (_, issuer_xprv) = derive_xprv(signer, "issuer", issuer_index)?;
    let (_, holder_xprv) = derive_xprv(signer, "holder", holder_index)?;
    let issuer = xonly_from_xprv(&issuer_xprv);
    let holder = xonly_from_xprv(&holder_xprv);
    let contract_hash = ContractHash::from_byte_array([0; 32]);
    let regulated_entropy = AssetId::generate_asset_entropy(selected[0].outpoint, contract_hash);
    let verifier_entropy = AssetId::generate_asset_entropy(selected[1].outpoint, contract_hash);
    let regulated_asset = AssetId::from_entropy(regulated_entropy);
    let verifier_asset = AssetId::from_entropy(verifier_entropy);
    let reissuance_token = AssetId::reissuance_token_from_entropy(regulated_entropy, false);
    anyhow::ensure!(
        [policy_asset, regulated_asset, verifier_asset]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == 3,
        "bootstrap asset roles collide"
    );
    let protocol = Protocol::new(ProtocolConfig {
        regulated_asset,
        verifier_asset,
        verifier_asset_amount: 1,
        issuer,
        network: request.network,
    })?;
    let initial_set = PolicySet::new(TreeDepth::D4, [])?;
    let commitment = initial_set.commitment();
    let anchor = protocol.anchor(commitment)?;
    let provisional = DeploymentManifestV1 {
        schema: REGISTRY_SCHEMA_V1.to_owned(),
        protocol: PROTOCOL_ID_V1.to_owned(),
        network: request.network,
        policy_asset: policy_asset.to_string(),
        regulated_asset: regulated_asset.to_string(),
        verifier_asset: verifier_asset.to_string(),
        verifier_asset_amount: 1,
        issuer_public_key: issuer.to_string(),
        deployment_salt: request.deployment_salt,
        genesis_anchor: format!("{}:0", "00".repeat(32)),
        asset: request.asset,
        issued_supply: supply.to_string(),
        supply_mode: request.supply_mode,
        reissuance_token: matches!(request.supply_mode, SupplyMode::IssuerManaged)
            .then(|| reissuance_token.to_string()),
        reissuance_entropy: matches!(request.supply_mode, SupplyMode::IssuerManaged)
            .then(|| regulated_entropy.to_string()),
        user_program_hash: hex::encode(protocol.user_executable_leaf_hash()),
        governance_program_hash: hex::encode(anchor.governance_program_hash()),
        contract_bundle_hash: crate::CONTRACT_BUNDLE_HASH.to_owned(),
    };
    let holder_script = protocol.user_script(holder)?;
    let holder_blinder = blinding_public_key(signer, &holder_script)?;
    let token_locator = selected[0]
        .wallet_key
        .as_ref()
        .context("first bootstrap input lacks wallet locator")?;
    let token_address = wallet_address(signer, &provisional, token_locator)?;

    let mut pset = PartiallySignedTransaction::new_v2();
    set_lwk_genesis_hash(&mut pset, &provisional)?;
    for utxo in &selected {
        add_validated_input(&mut pset, utxo);
    }
    {
        let regulated_input = &mut pset.inputs_mut()[0];
        regulated_input.issuance_value_amount = Some(supply);
        regulated_input.issuance_inflation_keys = Some(u64::from(matches!(
            request.supply_mode,
            SupplyMode::IssuerManaged
        )));
        regulated_input.issuance_asset_entropy = Some(contract_hash.to_byte_array());
        regulated_input.blinded_issuance = Some(0);
        let verifier_input = &mut pset.inputs_mut()[1];
        verifier_input.issuance_value_amount = Some(1);
        verifier_input.issuance_inflation_keys = Some(0);
        verifier_input.issuance_asset_entropy = Some(contract_hash.to_byte_array());
        verifier_input.blinded_issuance = Some(0);
    }
    pset.add_output(Output::new_explicit(
        anchor.script_pubkey(),
        1,
        verifier_asset,
        None,
    ));
    let mut holder_outputs = Vec::new();
    if supply > 1 {
        for value in [supply - 1, 1] {
            let index = pset.outputs().len();
            pset.add_output(Output::new_explicit(
                holder_script.clone(),
                value,
                regulated_asset,
                Some(BitcoinPublicKey::new(holder_blinder)),
            ));
            holder_outputs.push(index);
        }
    } else {
        pset.add_output(Output::new_explicit(
            holder_script,
            1,
            regulated_asset,
            None,
        ));
    }
    let token_output = if matches!(request.supply_mode, SupplyMode::IssuerManaged) {
        let index = pset.outputs().len();
        pset.add_output(Output::new_explicit(
            token_address.script_pubkey(),
            1,
            reissuance_token,
            Some(BitcoinPublicKey::new(
                token_address
                    .blinding_pubkey
                    .context("token address is not confidential")?,
            )),
        ));
        Some(index)
    } else {
        None
    };
    let policy_change = policy_total - fee;
    if policy_change > 0 {
        pset.add_output(Output::new_explicit(
            token_address.script_pubkey(),
            policy_change,
            policy_asset,
            None,
        ));
    }
    pset.add_output(Output::new_explicit(Script::new(), fee, policy_asset, None));

    let secrets = selected
        .iter()
        .enumerate()
        .map(|(index, utxo)| (index, utxo.secrets))
        .collect::<HashMap<usize, TxOutSecrets>>();
    if let Some(index) = token_output {
        blinding::blind_assets_and_values(&mut pset, &secrets, &[index])
            .context("bootstrap token blinding failed")?;
    }
    if !holder_outputs.is_empty() {
        blinding::blind_values(&mut pset, &secrets, &holder_outputs)
            .context("bootstrap holder-value blinding failed")?;
    }
    let mut wallet_indexes = Vec::new();
    for (index, utxo) in selected.iter().enumerate() {
        let locator = utxo.wallet_key.as_ref().expect("validated");
        add_wallet_metadata(signer, &mut pset, index, locator, &utxo.txout.script_pubkey)?;
        wallet_indexes.push(index);
    }
    finalize_lwk_wallet_inputs(signer, &mut pset, &wallet_indexes)?;
    let transaction = pset.extract_tx()?;
    let txid = transaction.txid().to_string();
    let mut deployment = provisional;
    deployment.genesis_anchor = format!("{txid}:0");
    let deployment_id = deployment.validate()?;
    let initial_policy = PolicySnapshotV1 {
        schema: REGISTRY_SCHEMA_V1.to_owned(),
        protocol: PROTOCOL_ID_V1.to_owned(),
        deployment_id: deployment_id.clone(),
        sequence: 0,
        parent_policy_root: None,
        parent_verifier_script_hash: None,
        tree_depth: TreeDepth::D4,
        set_root: hex::encode(commitment.root),
        entry_count: 0,
        policy_root: hex::encode(commitment.policy_digest()),
        verifier_program_hash: hex::encode(anchor.verifier_program_hash()),
        verifier_script_pubkey: hex::encode(anchor.script_pubkey().as_bytes()),
        entries: Vec::new(),
    };
    initial_policy.validate()?;
    let initial_receive_record = receive::create_receive_record(
        signer,
        network,
        CreateReceiveRecordRequest {
            alias: request.receive_alias,
            deployment: deployment.clone(),
            deployment_id: deployment_id.clone(),
        },
    )?
    .record;
    let review = OperationReview {
        deployment_id: deployment_id.clone(),
        operation: "bootstrap",
        regulated_amount: supply.to_string(),
        fee: fee.to_string(),
        input_count: selected.len(),
        output_count: pset.outputs().len(),
        current_depth: TreeDepth::D4,
        successor_depth: None,
        recipients: vec![initial_receive_record.alias.clone()],
    };
    Ok(BootstrapResult {
        sdk: SIGNER_SDK_VERSION,
        operation: "bootstrap",
        pset: pset.to_string(),
        transaction: elements::encode::serialize_hex(&transaction),
        txid,
        review,
        deployment,
        deployment_id,
        initial_policy,
        initial_receive_record,
        issuer_derivation_index: issuer_index,
        holder_derivation_index: holder_index,
        required_confirmations: request.required_confirmations,
    })
}
