use serde_json::{Value, json};
use simplicity_damp_core::ledger::{Outpoint, Txid};
use simplicity_damp_core::policy::{PolicySet, TreeDepth};
use simplicity_damp_core::registry::{BlacklistEntry, DeploymentManifest, PolicySnapshot};

fn manifest_json() -> Value {
    serde_json::from_str(include_str!(
        "../../../registry/fixtures/deployment.valid.json"
    ))
    .unwrap()
}
fn snapshot_json() -> Value {
    serde_json::from_str(include_str!("../../../registry/fixtures/policy.valid.json")).unwrap()
}

#[test]
fn registry_fixtures_round_trip_with_the_same_identity() {
    let manifest: DeploymentManifest = serde_json::from_value(manifest_json()).unwrap();
    let policy: PolicySnapshot = serde_json::from_value(snapshot_json()).unwrap();
    assert_eq!(manifest.deployment_id(), policy.deployment_id());
    assert_eq!(
        manifest.deployment_id().to_string(),
        "bb176f81323fbbfadfa6a64280f9ce7fd4a4d339f63ebf0119ed0a9783109761"
    );
    assert_eq!(serde_json::to_value(manifest).unwrap(), manifest_json());
    assert_eq!(serde_json::to_value(policy).unwrap(), snapshot_json());
}

#[test]
fn manifest_cannot_deserialize_invalid_values_or_cross_field_combinations() {
    for (field, value) in [
        ("protocol", json!("unsupported")),
        ("schema", json!("unsupported")),
        ("verifierAssetAmount", json!(2)),
        ("issuedSupply", json!((1u64 << 63).to_string())),
        ("deploymentSalt", json!("00".repeat(32))),
        ("genesisAnchor", json!(format!("{}:01", "11".repeat(32)))),
        ("issuerPublicKey", json!("ff".repeat(32))),
        ("audit", json!({"publicKey":"00".repeat(33),"epoch":1})),
        (
            "audit",
            json!({"publicKey":manifest_json()["audit"]["publicKey"],"epoch":0}),
        ),
        (
            "asset",
            json!({"name":" padded ","ticker":"T","precision":0}),
        ),
        ("asset", json!({"name":"N","ticker":"T","precision":9})),
        ("verifierAsset", manifest_json()["regulatedAsset"].clone()),
        ("reissuanceToken", json!("11".repeat(32))),
        ("unexpected", json!(true)),
    ] {
        let mut candidate = manifest_json();
        candidate[field] = value;
        assert!(
            serde_json::from_value::<DeploymentManifest>(candidate).is_err(),
            "accepted {field}"
        );
    }
    for field in ["audit", "reissuanceToken", "reissuanceEntropy"] {
        let mut candidate = manifest_json();
        candidate.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<DeploymentManifest>(candidate).is_err(),
            "missing {field}"
        );
    }
}

#[test]
fn policy_parsing_checks_lineage_and_rebuilds_commitments() {
    for (field, value) in [
        ("sequence", json!(1)),
        ("entryCount", json!(1)),
        ("treeDepth", json!(260)),
        ("setRoot", json!("ff".repeat(32))),
        ("policyRoot", json!("ff".repeat(32))),
        ("verifierScriptPubkey", json!("")),
        ("parentPolicyRoot", json!("ff".repeat(32))),
    ] {
        let mut candidate = snapshot_json();
        candidate[field] = value;
        assert!(
            serde_json::from_value::<PolicySnapshot>(candidate).is_err(),
            "accepted {field}"
        );
    }
    for field in ["parentPolicyRoot", "parentVerifierScriptHash"] {
        let mut candidate = snapshot_json();
        candidate.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<PolicySnapshot>(candidate).is_err(),
            "missing {field}"
        );
    }
}

#[test]
fn notes_do_not_change_consensus_commitments() {
    let outpoint = Outpoint::new(Txid::from([1; 32]), 0);
    let noted = BlacklistEntry::new(outpoint, Some("metadata only".into())).unwrap();
    let bare = BlacklistEntry::new(outpoint, None).unwrap();
    assert_eq!(
        PolicySet::new(TreeDepth::D4, [noted.key()])
            .unwrap()
            .commitment(),
        PolicySet::new(TreeDepth::D4, [bare.key()])
            .unwrap()
            .commitment()
    );
    assert!(BlacklistEntry::new(outpoint, Some("x".repeat(281))).is_err());
    assert!(serde_json::from_value::<BlacklistEntry>(json!({"txid":"XX","vout":0})).is_err());
}
