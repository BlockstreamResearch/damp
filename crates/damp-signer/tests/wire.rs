use serde_json::json;
use simplicity_damp_signer::network::DeploymentNetwork;
use simplicity_damp_signer::wire::{Operation, execute_native};
use simplicity_damp_signer::{Error, Signer};

const MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[test]
fn blacklist_depth_is_checked_before_any_narrowing_conversion() {
    for depth in [0, 3, 7, 260, 261, 262, u64::MAX] {
        assert!(matches!(
            Operation::parse("build-blacklist", json!({"depth": depth,"entries":[]})),
            Err(Error::Request(_))
        ));
    }
    for depth in [4, 5, 6] {
        assert!(matches!(
            Operation::parse("build-blacklist", json!({"depth":depth,"entries":[]})),
            Ok(Operation::BuildBlacklist(_))
        ));
    }
}

#[test]
fn wallet_coordinates_are_required_and_bounded() {
    for request in [
        json!({}),
        json!({"branch":0}),
        json!({"index":0}),
        json!({"branch":"0","index":0}),
        json!({"branch":0,"index":null}),
        json!({"branch":2,"index":0}),
        json!({"branch":0,"index":2147483648u64}),
        json!({"branch":0,"index":u64::MAX}),
    ] {
        assert!(matches!(
            Operation::parse("wallet-address", request),
            Err(Error::Request(_))
        ));
    }
    let address = execute_native(
        MNEMONIC,
        DeploymentNetwork::ElementsRegtest,
        "wallet-address",
        json!({"branch":1,"index":2147483647u32}),
    )
    .unwrap();
    assert_eq!(address["branch"], 1);
    assert_eq!(address["index"], 2147483647u32);
}

#[test]
fn request_rejection_precedes_signer_construction() {
    let error = execute_native(
        "not a mnemonic",
        DeploymentNetwork::ElementsRegtest,
        "wallet-address",
        json!({}),
    )
    .unwrap_err();
    assert!(matches!(error, Error::Request(_)));
    assert!(matches!(
        Operation::parse("unknown", json!({})),
        Err(Error::Request(_))
    ));
}

#[test]
fn signer_debug_does_not_expose_mnemonic_or_secret_state() {
    let signer = Signer::new(MNEMONIC, DeploymentNetwork::ElementsRegtest).unwrap();
    assert_eq!(
        format!("{signer:?}"),
        "Signer { network: ElementsRegtest, .. }"
    );
    assert!(matches!(
        Signer::new("secret invalid words", DeploymentNetwork::ElementsRegtest),
        Err(Error::Mnemonic)
    ));
}
