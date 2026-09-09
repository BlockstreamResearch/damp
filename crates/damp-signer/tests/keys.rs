use simplicity_damp_signer::{Signer, network::DeploymentNetwork};

#[test]
fn signer_info_debug_redacts_blinding_material_but_serialization_retains_the_descriptor()
-> Result<(), Box<dyn std::error::Error>> {
    let signer = Signer::new(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        DeploymentNetwork::ElementsRegtest,
    )?;
    let info = signer.info()?;
    let debug = format!("{info:?}");
    let blinding_key = info
        .descriptor
        .split_once("slip77(")
        .and_then(|(_, value)| value.split_once(')'))
        .map(|(key, _)| key)
        .ok_or("expected a SLIP77 descriptor")?;
    assert!(!blinding_key.is_empty());
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains(&info.descriptor));
    assert!(!debug.contains(blinding_key));
    let encoded = serde_json::to_value(&info)?;
    assert!(encoded["descriptor"].as_str() == Some(info.descriptor.as_str()));
    Ok(())
}
