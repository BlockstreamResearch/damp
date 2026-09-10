use damp_core::policy::{PolicySet, TreeDepth};
use damp_core::registry::{DeploymentManifest, PolicySnapshot};
use simplicity_damp_signer::{Signer, ops::request::PreparePolicyRequest};

#[test]
fn registry_fixture_matches_the_compiled_deployment() -> anyhow::Result<()> {
    let deployment: DeploymentManifest = serde_json::from_str(include_str!(
        "../../../registry/fixtures/deployment.valid.json"
    ))?;
    let snapshot: PolicySnapshot =
        serde_json::from_str(include_str!("../../../registry/fixtures/policy.valid.json"))?;
    assert_eq!(deployment.deployment_id(), snapshot.deployment_id());
    let prepared = Signer::prepare_policy(PreparePolicyRequest {
        deployment,
        policy: snapshot.tree().commitment(),
    })?;
    assert_eq!(prepared.policy_root, snapshot.policy_root());
    assert_eq!(
        prepared.verifier_program_hash,
        snapshot.verifier_program_hash()
    );
    assert_eq!(
        &prepared.verifier_script_pubkey,
        snapshot.verifier_script_pubkey()
    );
    Ok(())
}

#[test]
fn previous_bundle_is_not_silently_treated_as_compatible() -> anyhow::Result<()> {
    let mut previous: serde_json::Value = serde_json::from_str(include_str!(
        "../../../registry/fixtures/deployment.valid.json"
    ))?;
    previous["contractBundleHash"] =
        serde_json::json!("7eefff87a27f0616366375f5776b9febda2a78c0c57b9a9b4c63eaa84c103919");
    let error = Signer::prepare_policy(PreparePolicyRequest {
        deployment: serde_json::from_value(previous)?,
        policy: PolicySet::new(TreeDepth::D4, [])?.commitment(),
    })
    .expect_err("the previous bundle requires its original contracts");
    assert!(error.to_string().contains("contract bundle does not match"));
    Ok(())
}
