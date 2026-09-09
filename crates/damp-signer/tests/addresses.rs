use simplicity_damp_signer::{
    Signer,
    keys::{ConfidentialAddress, WalletBranch},
    network::DeploymentNetwork,
};

const MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[test]
fn address_parsing_cannot_bypass_confidentiality_or_network_checks()
-> Result<(), Box<dyn std::error::Error>> {
    for network in [
        DeploymentNetwork::ElementsRegtest,
        DeploymentNetwork::LiquidTestnet,
    ] {
        let signer = Signer::new(MNEMONIC, network)?;
        let derived = signer.wallet_address(WalletBranch::Receive, 0.try_into()?)?;
        let address = derived.confidential_address;
        assert_eq!(address.network(), network);
        assert_eq!(address.to_string().parse::<ConfidentialAddress>()?, address);
        let encoded = serde_json::to_value(&address)?;
        assert_eq!(
            serde_json::from_value::<ConfidentialAddress>(encoded)?,
            address
        );

        let unconfidential = elements::Address::from_script(
            &address.as_address().script_pubkey(),
            None,
            address.as_address().params,
        )
        .ok_or("address script")?;
        assert!(ConfidentialAddress::try_from(unconfidential.clone()).is_err());
        assert!(
            serde_json::from_value::<ConfidentialAddress>(serde_json::json!(
                unconfidential.to_string()
            ))
            .is_err()
        );

        let mainnet = elements::Address::from_script(
            &address.as_address().script_pubkey(),
            Some(address.blinding_key()),
            &elements::AddressParams::LIQUID,
        )
        .ok_or("address script")?;
        assert!(ConfidentialAddress::try_from(mainnet).is_err());
        assert!(
            format!(" {}", address)
                .parse::<ConfidentialAddress>()
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn holder_validation_retains_the_parsed_address_and_deployment_binding()
-> Result<(), Box<dyn std::error::Error>> {
    let deployment: damp_core::registry::DeploymentManifest = serde_json::from_str(include_str!(
        "../../../registry/fixtures/deployment.valid.json"
    ))?;
    let signer = Signer::new(MNEMONIC, deployment.network())?;
    let derived = signer.holder_address(&deployment)?;
    let recipient =
        signer.validate_recipient_address(&deployment, &derived.confidential_address)?;
    assert_eq!(recipient.deployment_id(), deployment.deployment_id());
    assert_eq!(recipient.address(), &derived.confidential_address);
    assert_eq!(recipient.owner().to_string(), derived.owner_public_key);

    let mut changed: damp_core::registry::wire::ManifestFields = deployment.clone().into();
    changed.regulated_asset = damp_core::ledger::AssetId::from([0xde; 32]);
    assert!(
        signer
            .validate_recipient_address(&changed.try_into()?, recipient.address())
            .is_err()
    );
    let other_network = Signer::new(MNEMONIC, DeploymentNetwork::LiquidTestnet)?;
    assert!(
        other_network
            .validate_recipient_address(&deployment, recipient.address())
            .is_err()
    );
    Ok(())
}
