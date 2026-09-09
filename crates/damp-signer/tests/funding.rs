mod support;
use damp_core::registry::{AssetMetadata, SupplyMode};
use elements::{AssetId, confidential::Value};
use simplicity_damp_signer::{
    Signer,
    network::DeploymentNetwork,
    ops::request::{BootstrapRequest, SplitFundingRequest},
    utxo::{InputSource, InputStatus, Ownership, Utxo},
};
use std::str::FromStr;
use support::{MNEMONIC, confidential_funding_utxo, funding_utxo, parent_utxo, public_asset};

fn request(asset: AssetId, source_utxos: Vec<Utxo>) -> SplitFundingRequest {
    SplitFundingRequest {
        network: DeploymentNetwork::ElementsRegtest,
        policy_asset: public_asset(asset),
        source_utxos,
        fee: "500".parse().expect("valid fixture amount"),
    }
}

#[test]
fn split_conserves_value_and_shape() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let asset = AssetId::from_str(&"aa".repeat(32))?;
    let source = funding_utxo(&signer, network, asset, 100_000, 1, 0)?;
    let result = signer.split_funding(request(asset, vec![source]))?;
    assert_eq!(result.operation, "funding-split");
    assert_eq!(result.outputs[0].amount, "49750");
    assert_eq!(result.outputs[1].amount, "49750");
    let transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(&result.transaction)?)?;
    assert_eq!(transaction.input.len(), 1);
    assert_eq!(transaction.output.len(), 3);
    assert_eq!(transaction.output[2].value.explicit(), Some(500));
    Ok(())
}

#[test]
fn split_handles_odd_values_and_confidential_inputs() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let asset = AssetId::from_str(&"ab".repeat(32))?;
    let source = confidential_funding_utxo(&signer, network, asset, 100_001, 0)?;
    let result = signer.split_funding(request(asset, vec![source]))?;
    assert_eq!(result.outputs[0].amount, "49750");
    assert_eq!(result.outputs[1].amount, "49751");
    let transaction: elements::Transaction =
        elements::encode::deserialize(&hex::decode(&result.transaction)?)?;
    assert!(matches!(
        transaction.output[0].value,
        Value::Confidential(_)
    ));
    assert!(matches!(
        transaction.output[1].value,
        Value::Confidential(_)
    ));
    Ok(())
}

#[test]
fn split_rejects_unnecessary_or_unusable_shapes() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let asset = AssetId::from_str(&"ac".repeat(32))?;
    let empty = signer.split_funding(request(asset, vec![])).unwrap_err();
    assert_eq!(
        empty.to_string(),
        "funding split failed: funding split needs one confirmed L-BTC output"
    );
    let two = signer
        .split_funding(request(
            asset,
            vec![
                funding_utxo(&signer, network, asset, 10_000, 2, 0)?,
                funding_utxo(&signer, network, asset, 10_000, 3, 1)?,
            ],
        ))
        .unwrap_err();
    assert_eq!(
        two.to_string(),
        "funding split failed: funding already provides two distinct confirmed outputs; a split is unnecessary"
    );
    let small = signer
        .split_funding(request(
            asset,
            vec![funding_utxo(&signer, network, asset, 2_501, 4, 0)?],
        ))
        .unwrap_err();
    assert!(
        small
            .to_string()
            .starts_with("funding split failed: split source output cannot fund")
    );

    let boundary = signer.split_funding(request(
        asset,
        vec![funding_utxo(&signer, network, asset, 2_502, 6, 0)?],
    ))?;
    assert_eq!(boundary.outputs[0].amount, "1001");
    assert_eq!(boundary.outputs[1].amount, "1001");

    let mut missing_key = funding_utxo(&signer, network, asset, 10_000, 7, 0)?;
    missing_key = Utxo::new(
        missing_key.outpoint(),
        InputSource::Output(missing_key.txout().clone()),
        Ownership::Unlocated,
        InputStatus::Spendable,
    )?;
    assert_eq!(
        signer
            .split_funding(request(asset, vec![missing_key]))
            .unwrap_err()
            .to_string(),
        "funding split failed: split input needs a wallet key locator"
    );

    let mut low_fee = request(
        asset,
        vec![funding_utxo(&signer, network, asset, 10_000, 8, 0)?],
    );
    low_fee.fee = "50".parse()?;
    assert_eq!(
        signer.split_funding(low_fee).unwrap_err().to_string(),
        "funding split failed: split fee must be between 100 and 10000 sats"
    );

    let mismatch = SplitFundingRequest {
        network: DeploymentNetwork::LiquidTestnet,
        policy_asset: public_asset(asset),
        source_utxos: vec![funding_utxo(&signer, network, asset, 10_000, 9, 0)?],
        fee: "500".parse().expect("valid fixture amount"),
    };
    let simplicity_damp_signer::Error::Operation { source, .. } =
        signer.split_funding(mismatch).unwrap_err()
    else {
        panic!("expected a network validation failure");
    };
    assert_eq!(
        source.downcast_ref::<simplicity_damp_signer::network::NetworkMismatch>(),
        Some(&simplicity_damp_signer::network::NetworkMismatch {
            signer: DeploymentNetwork::ElementsRegtest,
            requested: DeploymentNetwork::LiquidTestnet,
        })
    );
    Ok(())
}

#[test]
fn split_outputs_bootstrap_with_distinct_asset_roles() -> anyhow::Result<()> {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest)?;
    let network = DeploymentNetwork::ElementsRegtest;
    let asset = AssetId::from_str(&"ad".repeat(32))?;
    let source = funding_utxo(&signer, network, asset, 100_000, 5, 0)?;
    let split = signer.split_funding(request(asset, vec![source]))?;
    let funding = split
        .outputs
        .iter()
        .map(|output| {
            parent_utxo(
                &split.txid,
                output.vout,
                &split.transaction,
                Some(output.wallet_key),
                None,
            )
        })
        .collect();
    let bootstrapped = signer.bootstrap(BootstrapRequest {
        network: DeploymentNetwork::ElementsRegtest,
        policy_asset: public_asset(asset),
        deployment_salt: "45".repeat(32).parse()?,
        asset: AssetMetadata::new("Split lifecycle".to_owned(), "SPL".to_owned(), 0)?,
        issued_supply: "1000".parse().expect("valid fixture amount"),
        supply_mode: SupplyMode::Fixed,
        policy_utxos: funding,
        fee: "2000".parse().expect("valid fixture amount"),
        required_confirmations: 1,
    })?;
    assert_ne!(
        bootstrapped.deployment.regulated_asset(),
        bootstrapped.deployment.verifier_asset()
    );
    Ok(())
}
