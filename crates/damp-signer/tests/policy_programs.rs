use damp_core::registry::{DeploymentManifest, PolicySnapshot};
use simplicity_damp_signer::{Signer, ops::request::PreparePolicyRequest};

fn request() -> PreparePolicyRequest {
    let deployment: DeploymentManifest = serde_json::from_str(include_str!(
        "../../../registry/fixtures/deployment.valid.json"
    ))
    .unwrap();
    let policy: PolicySnapshot =
        serde_json::from_str(include_str!("../../../registry/fixtures/policy.valid.json")).unwrap();
    assert_eq!(deployment.deployment_id(), policy.deployment_id());
    PreparePolicyRequest {
        deployment,
        policy: policy.tree().commitment(),
    }
}

#[test]
fn registry_fixture_matches_compiled_programs() {
    let policy: PolicySnapshot =
        serde_json::from_str(include_str!("../../../registry/fixtures/policy.valid.json")).unwrap();
    let prepared = Signer::prepare_policy(request()).unwrap();
    assert_eq!(prepared.policy_root, policy.policy_root());
    assert_eq!(
        prepared.verifier_program_hash,
        policy.verifier_program_hash()
    );
    assert_eq!(
        &prepared.verifier_script_pubkey,
        policy.verifier_script_pubkey()
    );
}

#[test]
fn preparation_rejects_another_source_bundle_or_executable_commitment() {
    for field in [
        "contractBundleHash",
        "userProgramHash",
        "governanceProgramHash",
    ] {
        let mut request = request();
        let mut manifest = serde_json::to_value(&request.deployment).unwrap();
        manifest[field] = serde_json::json!("ff".repeat(32));
        request.deployment = serde_json::from_value(manifest).unwrap();
        let error = Signer::prepare_policy(request).unwrap_err();
        assert!(
            error.to_string().contains("does not match"),
            "{field}: {error}"
        );
    }
}

#[test]
fn preparation_parses_commitment_invariants_before_native_execution() {
    let native = request();
    let fields = serde_json::json!({
        "deployment": native.deployment,
        "treeDepth": native.policy.depth(),
        "setRoot": native.policy.root(),
        "entryCount": native.policy.count(),
    });
    let parsed: PreparePolicyRequest = serde_json::from_value(fields.clone()).unwrap();
    assert_eq!(parsed.policy, native.policy);
    assert!(
        simplicity_damp_signer::wire::Operation::parse("prepare-policy", fields.clone()).is_ok()
    );
    for (field, value) in [
        ("entryCount", serde_json::json!(65)),
        ("setRoot", serde_json::json!("ff".repeat(32))),
        ("treeDepth", serde_json::json!(7)),
    ] {
        let mut invalid = fields.clone();
        invalid[field] = value;
        assert!(serde_json::from_value::<PreparePolicyRequest>(invalid.clone()).is_err());
        assert!(simplicity_damp_signer::wire::Operation::parse("prepare-policy", invalid).is_err());
    }
}
