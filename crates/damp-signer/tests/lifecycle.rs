mod support;
use simplicity_damp_signer::{
    Signer,
    audit::verify_report,
    keys::{HolderKeyLocator, WalletBranch, WalletKeyLocator},
    network::DeploymentNetwork,
    ops::request::{
        BootstrapRequest, PolicyUpdateRequest, PreparePolicyRequest, ReissuanceRequest,
        SplitFundingRequest, TransferRequest,
    },
    utxo::{InputSource, InputStatus, Utxo},
    wire::{execute_audit_credentials, export_audit_credentials_json},
};
use std::str::FromStr;
use support::{MNEMONIC, confidential_funding_utxo, funding_utxo, parent_utxo, public_asset};

use anyhow::Context;
use damp_core::policy::{PolicySet, TreeDepth};
use damp_core::registry::{AssetMetadata, PolicySnapshot, REGISTRY_SCHEMA, SupplyMode};
use elements::confidential::Value;
use elements::hashes::Hash as _;
use elements::{Address, AssetId};

#[test]
fn managed_lifecycle_builds_and_executes_every_operation() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let policy_asset = AssetId::from_str(&"aa".repeat(32))?;
    let funding = [
        funding_utxo(&signer, network, policy_asset, 20_000, 1, 0)?,
        funding_utxo(&signer, network, policy_asset, 20_000, 2, 1)?,
    ];
    let bootstrapped = signer.bootstrap(BootstrapRequest {
        network: DeploymentNetwork::ElementsRegtest,
        policy_asset: public_asset(policy_asset),
        deployment_salt: "11".repeat(32).parse()?,
        asset: AssetMetadata::new("DAMP Test Asset".to_owned(), "DAMPT".to_owned(), 0)?,
        issued_supply: "1000".parse().expect("valid fixture amount"),
        supply_mode: SupplyMode::IssuerManaged,
        policy_utxos: funding.to_vec(),
        fee: "4000".parse().expect("valid fixture amount"),
        required_confirmations: 1,
    })?;
    bootstrapped.deployment.deployment_id();
    bootstrapped.initial_policy.tree();
    let credentials_json = export_audit_credentials_json(
        MNEMONIC,
        network,
        serde_json::json!({
            "deployment": bootstrapped.deployment,
            "issuerTransactions": [bootstrapped.transaction],
        }),
    )?;
    assert!(!credentials_json.contains("abandon"));
    let report_json = serde_json::to_string(&serde_json::json!({
        "deploymentId": bootstrapped.deployment_id,
        "network": bootstrapped.deployment.network().as_str(),
    }))?;
    let signed = execute_audit_credentials(
        &credentials_json,
        network,
        "sign-audit-report",
        serde_json::json!({
            "deployment": bootstrapped.deployment,
            "reportJson": report_json,
        }),
    )?;
    let report_public = signed["publicKey"].as_str().context("report key missing")?;
    assert_ne!(
        report_public,
        bootstrapped.deployment.issuer_public_key().to_string()
    );
    verify_report(
        signed["certificateJson"]
            .as_str()
            .context("certificate missing")?,
        &signed["certificateSignature"]
            .as_str()
            .context("certificate signature missing")?
            .parse()?,
        bootstrapped.deployment.issuer_public_key(),
    )
    .map_err(|_| anyhow::anyhow!("issuer certificate did not verify"))?;
    verify_report(
        &report_json,
        &signed["signature"]
            .as_str()
            .context("report signature missing")?
            .parse()?,
        report_public.parse()?,
    )
    .map_err(|_| anyhow::anyhow!("report signature did not verify"))?;
    for unavailable in ["transfer", "reissue", "policy-update"] {
        let error = execute_audit_credentials(
            &credentials_json,
            network,
            unavailable,
            serde_json::json!({"deployment":bootstrapped.deployment}),
        )
        .expect_err("restricted credentials exposed a spending operation");
        assert!(error.to_string().contains("operation unavailable"));
    }
    let mut tampered: serde_json::Value = serde_json::from_str(&credentials_json)?;
    let signature = tampered["certificateSignature"]
        .as_str()
        .context("certificate signature missing")?;
    tampered["certificateSignature"] = serde_json::Value::String(format!(
        "{}{}",
        if &signature[..1] == "0" { "1" } else { "0" },
        &signature[1..]
    ));
    assert!(
        execute_audit_credentials(
            &serde_json::to_string(&tampered)?,
            network,
            "sign-audit-report",
            serde_json::json!({
                "deployment":bootstrapped.deployment,
                "reportJson":report_json,
            }),
        )
        .is_err()
    );
    assert!(
        execute_audit_credentials(
            &credentials_json,
            network,
            "sign-audit-report",
            serde_json::json!({
                "deployment":bootstrapped.deployment,
                "reportJson":serde_json::to_string(&serde_json::json!({
                    "deploymentId":"00".repeat(32),
                    "network":bootstrapped.deployment.network().as_str(),
                }))?,
            }),
        )
        .is_err()
    );
    let regulated_asset = AssetId::from_byte_array(
        bootstrapped
            .deployment
            .regulated_asset()
            .to_consensus_byte_array(),
    );
    let bootstrap_transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(&bootstrapped.transaction)?)?;
    let funding_outputs = funding
        .iter()
        .map(|input| input.txout().clone())
        .collect::<Vec<_>>();
    Signer::verify_transaction(&bootstrap_transaction, &funding_outputs, 4000.try_into()?)?;
    assert!(
        Signer::verify_transaction(&bootstrap_transaction, &funding_outputs, 499.try_into()?)
            .is_err()
    );
    assert_eq!(
        bootstrap_transaction.output[1].asset.explicit(),
        Some(regulated_asset)
    );
    assert_eq!(bootstrap_transaction.output[1].value.explicit(), Some(1000));
    assert_eq!(
        bootstrap_transaction
            .output
            .iter()
            .filter(|output| output.asset.explicit() == Some(regulated_asset))
            .count(),
        1
    );
    signer.validate_recipient_address(
        &bootstrapped.deployment,
        &bootstrapped.initial_holder_address.confidential_address,
    )?;
    assert!(
        "not-an-address"
            .parse::<simplicity_damp_signer::keys::ConfidentialAddress>()
            .is_err()
    );
    let parsed_holder = bootstrapped
        .initial_holder_address
        .confidential_address
        .as_address();
    let unconfidential =
        Address::from_script(&parsed_holder.script_pubkey(), None, parsed_holder.params)
            .ok_or_else(|| anyhow::anyhow!("holder script has no unconfidential address"))?;
    assert!(simplicity_damp_signer::keys::ConfidentialAddress::try_from(unconfidential).is_err());
    let mut incompatible: damp_core::registry::wire::ManifestFields =
        bootstrapped.deployment.clone().into();
    incompatible.regulated_asset = "de".repeat(32).parse()?;
    let incompatible = incompatible.try_into()?;
    assert!(
        signer
            .validate_recipient_address(
                &incompatible,
                &bootstrapped.initial_holder_address.confidential_address,
            )
            .is_err()
    );
    assert!(
        Signer::new(MNEMONIC, DeploymentNetwork::LiquidTestnet)?
            .validate_recipient_address(
                &bootstrapped.deployment,
                &bootstrapped.initial_holder_address.confidential_address,
            )
            .is_err()
    );

    let bootstrap_tx = bootstrapped.transaction.clone();
    let verifier = parent_utxo(&bootstrapped.txid, 0, &bootstrap_tx, None, None);
    let holder = parent_utxo(
        &bootstrapped.txid,
        1,
        &bootstrap_tx,
        None,
        Some(HolderKeyLocator {
            derivation_index: bootstrapped.holder_derivation_index,
            owner_public_key: bootstrapped
                .initial_holder_address
                .owner_public_key
                .parse()?,
        }),
    );
    let token = parent_utxo(
        &bootstrapped.txid,
        2,
        &bootstrap_tx,
        Some(WalletKeyLocator {
            branch: simplicity_damp_signer::keys::WalletBranch::Receive,
            index: simplicity_damp_signer::keys::KeyIndex::ZERO,
        }),
        None,
    );
    let bootstrap_fee_change = parent_utxo(
        &bootstrapped.txid,
        3,
        &bootstrap_tx,
        Some(WalletKeyLocator {
            branch: simplicity_damp_signer::keys::WalletBranch::Receive,
            index: simplicity_damp_signer::keys::KeyIndex::ZERO,
        }),
        None,
    );
    let transfer = signer.transfer(TransferRequest {
        deployment: bootstrapped.deployment.clone(),
        current_policy: bootstrapped.initial_policy.clone(),
        verifier_utxo: verifier,
        regulated_utxos: vec![holder],
        fee_utxos: vec![bootstrap_fee_change],
        recipient_address: bootstrapped
            .initial_holder_address
            .confidential_address
            .clone(),
        amount: "600".parse().expect("valid fixture amount"),
        fee: "4000".parse().expect("valid fixture amount"),
    })?;
    assert_eq!(transfer.operation, "transfer");
    let transfer_transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(&transfer.transaction)?)?;
    assert_eq!(
        transfer_transaction.output[1].asset.explicit(),
        Some(regulated_asset)
    );
    assert_eq!(transfer_transaction.output[1].value.explicit(), None);
    assert_eq!(
        transfer_transaction.output[2].asset.explicit(),
        Some(regulated_asset)
    );
    assert_eq!(transfer_transaction.output[2].value.explicit(), None);
    let mut transfer_anchor = parent_utxo(&transfer.txid, 0, &transfer.transaction, None, None);
    let mut transfer_fee_change = parent_utxo(
        &transfer.txid,
        3,
        &transfer.transaction,
        Some(WalletKeyLocator {
            branch: simplicity_damp_signer::keys::WalletBranch::Receive,
            index: simplicity_damp_signer::keys::KeyIndex::ZERO,
        }),
        None,
    );

    let confidential_holder = parent_utxo(
        &transfer.txid,
        1,
        &transfer.transaction,
        None,
        Some(HolderKeyLocator {
            derivation_index: bootstrapped.holder_derivation_index,
            owner_public_key: bootstrapped
                .initial_holder_address
                .owner_public_key
                .parse()?,
        }),
    );
    assert_eq!(
        signer.inspect(std::slice::from_ref(&confidential_holder))?[0]
            .amount
            .parse::<u64>()?,
        600
    );
    let again = signer.transfer(TransferRequest {
        deployment: bootstrapped.deployment.clone(),
        current_policy: bootstrapped.initial_policy.clone(),
        verifier_utxo: transfer_anchor,
        regulated_utxos: vec![confidential_holder],
        fee_utxos: vec![transfer_fee_change],
        recipient_address: bootstrapped
            .initial_holder_address
            .confidential_address
            .clone(),
        amount: "300".parse().expect("valid fixture amount"),
        fee: "4000".parse().expect("valid fixture amount"),
    })?;
    transfer_anchor = parent_utxo(&again.txid, 0, &again.transaction, None, None);
    transfer_fee_change = parent_utxo(
        &again.txid,
        3,
        &again.transaction,
        Some(WalletKeyLocator {
            branch: simplicity_damp_signer::keys::WalletBranch::Receive,
            index: simplicity_damp_signer::keys::KeyIndex::ZERO,
        }),
        None,
    );

    let successor_set = PolicySet::new(TreeDepth::D5, [])?;
    let successor_commitment = successor_set.commitment();
    let prepared = Signer::prepare_policy(PreparePolicyRequest {
        deployment: bootstrapped.deployment.clone(),
        policy: successor_commitment,
    })?;
    let successor: PolicySnapshot = damp_core::registry::wire::SnapshotFields {
        schema: REGISTRY_SCHEMA.to_owned(),
        protocol: damp_core::registry::PROTOCOL_ID.to_owned(),
        deployment_id: bootstrapped.deployment_id,
        sequence: 1,
        parent_policy_root: Some(bootstrapped.initial_policy.policy_root()),
        parent_verifier_script_hash: Some(bootstrapped.initial_policy.verifier_script_hash()),
        tree_depth: TreeDepth::D5,
        set_root: successor_commitment.root(),
        entry_count: 0,
        policy_root: prepared.policy_root,
        verifier_program_hash: prepared.verifier_program_hash,
        verifier_script_pubkey: prepared.verifier_script_pubkey,
        entries: Vec::new(),
    }
    .try_into()?;
    let policy_update = signer.update_policy(PolicyUpdateRequest {
        deployment: bootstrapped.deployment.clone(),
        current_policy: bootstrapped.initial_policy.clone(),
        successor_policy: successor.clone(),
        verifier_utxo: transfer_anchor,
        fee_utxos: vec![transfer_fee_change],
        fee: "4000".parse().expect("valid fixture amount"),
        issuer_derivation_index: bootstrapped.issuer_derivation_index,
    })?;
    assert_eq!(policy_update.review.successor_depth, Some(TreeDepth::D5));

    let update_anchor = parent_utxo(
        &policy_update.txid,
        0,
        &policy_update.transaction,
        None,
        None,
    );
    let update_fee_change = parent_utxo(
        &policy_update.txid,
        1,
        &policy_update.transaction,
        Some(WalletKeyLocator {
            branch: simplicity_damp_signer::keys::WalletBranch::Receive,
            index: simplicity_damp_signer::keys::KeyIndex::ZERO,
        }),
        None,
    );
    let reissued = signer.reissue(ReissuanceRequest {
        deployment: bootstrapped.deployment,
        current_policy: successor,
        verifier_utxo: update_anchor,
        token_utxo: token,
        fee_utxos: vec![update_fee_change],
        recipient_address: bootstrapped.initial_holder_address.confidential_address,
        amount: "100".parse().expect("valid fixture amount"),
        fee: "4000".parse().expect("valid fixture amount"),
        issuer_derivation_index: bootstrapped.issuer_derivation_index,
    })?;
    assert_eq!(reissued.operation, "reissuance");
    let reissuance_transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(&reissued.transaction)?)?;
    assert_eq!(
        reissuance_transaction.output[1].asset.explicit(),
        Some(regulated_asset)
    );
    assert_eq!(reissuance_transaction.output[1].value.explicit(), Some(100));
    assert_eq!(
        reissuance_transaction
            .output
            .iter()
            .filter(|output| output.asset.explicit() == Some(regulated_asset))
            .count(),
        1
    );
    Ok(())
}

#[test]
fn pending_wallet_output_can_be_inspected_but_not_spent() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let asset = AssetId::from_str(&"aa".repeat(32))?;
    let mut pending = funding_utxo(&signer, network, asset, 5_000, 9, 0)?;
    pending = Utxo::new(
        pending.outpoint(),
        InputSource::Output(pending.txout().clone()),
        pending.ownership(),
        InputStatus::Pending,
    )?;

    let inspected = signer.inspect(&[pending.clone()])?;
    assert_eq!(inspected[0].amount, "5000");
    assert_eq!(inspected[0].asset_id, asset.to_string());
    assert!(
        signer
            .split_funding(SplitFundingRequest {
                network: DeploymentNetwork::ElementsRegtest,
                policy_asset: public_asset(asset),
                source_utxos: vec![pending],
                fee: 500.try_into()?
            })
            .is_err()
    );
    Ok(())
}

#[test]
fn bootstrap_accepts_confidential_lbtc_and_normalizes_explicit_asset_change() -> anyhow::Result<()>
{
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let policy_asset = AssetId::from_str(&"aa".repeat(32))?;
    let funding = vec![
        confidential_funding_utxo(&signer, network, policy_asset, 100_000, 0)?,
        confidential_funding_utxo(&signer, network, policy_asset, 100_000, 1)?,
    ];
    assert!(
        signer
            .inspect(&funding)?
            .iter()
            .all(|output| output.asset_confidential && output.value_confidential)
    );

    let bootstrapped = signer.bootstrap(BootstrapRequest {
        network: DeploymentNetwork::ElementsRegtest,
        policy_asset: public_asset(policy_asset),
        deployment_salt: "22".repeat(32).parse()?,
        asset: AssetMetadata::new("Confidential funding test".to_owned(), "CFT".to_owned(), 0)?,
        issued_supply: "1000".parse().expect("valid fixture amount"),
        supply_mode: SupplyMode::IssuerManaged,
        policy_utxos: funding.clone(),
        fee: "2000".parse().expect("valid fixture amount"),
        required_confirmations: 1,
    })?;

    let transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(&bootstrapped.transaction)?)?;
    let (serialized_regulated_asset, serialized_token_asset) = transaction.input[0].issuance_ids();
    let (serialized_verifier_asset, _) = transaction.input[1].issuance_ids();
    assert_eq!(
        transaction.input[0].asset_issuance.inflation_keys,
        Value::Explicit(1)
    );
    assert_eq!(
        transaction.input[1].asset_issuance.inflation_keys,
        Value::Null
    );
    assert_eq!(
        serialized_regulated_asset.to_string(),
        bootstrapped.deployment.regulated_asset().to_string()
    );
    assert_eq!(
        serialized_token_asset.to_string(),
        bootstrapped
            .deployment
            .supply()
            .token()
            .unwrap()
            .to_string()
    );
    assert_eq!(
        serialized_verifier_asset.to_string(),
        bootstrapped.deployment.verifier_asset().to_string()
    );
    let regulated_asset = AssetId::from_byte_array(
        bootstrapped
            .deployment
            .regulated_asset()
            .to_consensus_byte_array(),
    );
    assert_eq!(
        transaction.output[1].asset.explicit(),
        Some(regulated_asset)
    );
    assert_eq!(transaction.output[1].value.explicit(), Some(1000));
    assert_eq!(
        transaction
            .output
            .iter()
            .filter(|output| output.asset.explicit() == Some(regulated_asset))
            .count(),
        1
    );
    let spent_outputs = transaction
        .input
        .iter()
        .map(|input| {
            funding
                .iter()
                .find(|utxo| {
                    damp_core::ledger::ConsensusTxid::from(utxo.outpoint().txid()).to_byte_array()
                        == input.previous_output.txid.to_byte_array()
                        && utxo.outpoint().vout() == input.previous_output.vout
                })
                .map(|utxo| utxo.txout().clone())
                .context("input is not a funding output")
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    Signer::verify_transaction(&transaction, &spent_outputs, 2000.try_into()?)?;
    let mut change_total = 0u64;
    for (vout, index) in [(3, 0), (4, 1)] {
        let change = transaction
            .output
            .get(vout as usize)
            .context("missing normalized L-BTC change")?;
        assert_eq!(change.asset.explicit(), Some(policy_asset));
        assert!(matches!(change.value, Value::Confidential(_)));

        let output = parent_utxo(
            &bootstrapped.txid,
            vout,
            &bootstrapped.transaction,
            Some(WalletKeyLocator {
                branch: WalletBranch::Change,
                index: index.try_into()?,
            }),
            None,
        );
        let inspected = signer.inspect(&[output])?;
        change_total += inspected[0].amount.parse::<u64>()?;
        assert!(!inspected[0].asset_confidential);
        assert!(inspected[0].value_confidential);
    }
    assert_eq!(change_total, 198_000);

    let transfer = signer.transfer(TransferRequest {
        deployment: bootstrapped.deployment.clone(),
        current_policy: bootstrapped.initial_policy.clone(),
        verifier_utxo: parent_utxo(&bootstrapped.txid, 0, &bootstrapped.transaction, None, None),
        regulated_utxos: vec![parent_utxo(
            &bootstrapped.txid,
            1,
            &bootstrapped.transaction,
            None,
            Some(HolderKeyLocator {
                derivation_index: bootstrapped.holder_derivation_index,
                owner_public_key: bootstrapped
                    .initial_holder_address
                    .owner_public_key
                    .parse()?,
            }),
        )],
        fee_utxos: vec![parent_utxo(
            &bootstrapped.txid,
            3,
            &bootstrapped.transaction,
            Some(WalletKeyLocator {
                branch: simplicity_damp_signer::keys::WalletBranch::Change,
                index: simplicity_damp_signer::keys::KeyIndex::ZERO,
            }),
            None,
        )],
        recipient_address: bootstrapped.initial_holder_address.confidential_address,
        amount: "600".parse().expect("valid fixture amount"),
        fee: "4000".parse().expect("valid fixture amount"),
    })?;
    assert_eq!(transfer.operation, "transfer");
    let transfer_transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(transfer.transaction)?)?;
    assert_eq!(
        transfer_transaction.output[1].asset.explicit(),
        Some(regulated_asset)
    );
    assert_eq!(transfer_transaction.output[1].value.explicit(), None);
    assert_eq!(
        transfer_transaction.output[2].asset.explicit(),
        Some(regulated_asset)
    );
    assert_eq!(transfer_transaction.output[2].value.explicit(), None);
    Ok(())
}

#[test]
fn fixed_supply_bootstrap_uses_null_reissuance_fields() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let policy_asset = AssetId::from_str(&"bb".repeat(32))?;
    let funding = vec![
        confidential_funding_utxo(&signer, network, policy_asset, 50_000, 0)?,
        confidential_funding_utxo(&signer, network, policy_asset, 50_000, 1)?,
    ];
    let bootstrapped = signer.bootstrap(BootstrapRequest {
        network: DeploymentNetwork::ElementsRegtest,
        policy_asset: public_asset(policy_asset),
        deployment_salt: "33".repeat(32).parse()?,
        asset: AssetMetadata::new("Fixed supply test".to_owned(), "FIX".to_owned(), 0)?,
        issued_supply: "1000".parse().expect("valid fixture amount"),
        supply_mode: SupplyMode::Fixed,
        policy_utxos: funding,
        fee: "2000".parse().expect("valid fixture amount"),
        required_confirmations: 1,
    })?;
    assert!(bootstrapped.deployment.supply().token().is_none());
    assert!(bootstrapped.deployment.supply().entropy().is_none());
    let transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(&bootstrapped.transaction)?)?;
    assert_eq!(
        transaction.input[0].asset_issuance.inflation_keys,
        Value::Null
    );
    assert_eq!(
        transaction.input[1].asset_issuance.inflation_keys,
        Value::Null
    );
    Ok(())
}

#[test]
fn bootstrap_extends_confidential_selection_for_split_change() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let policy_asset = AssetId::from_str(&"bc".repeat(32))?;
    let funding = vec![
        confidential_funding_utxo(&signer, network, policy_asset, 1_000, 0)?,
        confidential_funding_utxo(&signer, network, policy_asset, 1_000, 1)?,
        confidential_funding_utxo(&signer, network, policy_asset, 5_000, 2)?,
    ];
    let result = signer.bootstrap(BootstrapRequest {
        network: DeploymentNetwork::ElementsRegtest,
        policy_asset: public_asset(policy_asset),
        deployment_salt: "44".repeat(32).parse()?,
        asset: AssetMetadata::new("Confidential headroom test".to_owned(), "CHT".to_owned(), 0)?,
        issued_supply: "1000".parse().expect("valid fixture amount"),
        supply_mode: SupplyMode::Fixed,
        policy_utxos: funding,
        fee: "2000".parse().expect("valid fixture amount"),
        required_confirmations: 1,
    })?;
    let transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(result.transaction)?)?;
    assert_eq!(transaction.input.len(), 3);
    Ok(())
}
