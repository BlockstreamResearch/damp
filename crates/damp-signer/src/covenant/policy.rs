pub use damp_core::policy::IndexedInputPolicyProof;
use elements::OutPoint;
use elements::hashes::Hash as _;

use crate::SIGNER_SDK_VERSION;
use crate::covenant::program::{Protocol, ProtocolConfig};
use crate::ops::request::PreparePolicyRequest;
use crate::ops::review::PreparedPolicy;

#[must_use]
pub fn outpoint_key(outpoint: OutPoint) -> damp_core::policy::PolicyKey {
    let txid = damp_core::ledger::ConsensusTxid::from(outpoint.txid.to_byte_array()).into();
    damp_core::policy::PolicyKey::for_outpoint(damp_core::ledger::Outpoint::new(
        txid,
        outpoint.vout,
    ))
}

pub fn prepare_policy(request: PreparePolicyRequest) -> anyhow::Result<PreparedPolicy> {
    let policy = request.policy;
    let protocol = protocol_for_deployment(&request.deployment)?;
    let anchor = protocol.anchor(policy)?;
    anyhow::ensure!(
        protocol.user_executable_leaf_hash()
            == request.deployment.user_program_hash().to_byte_array(),
        "bundled user program does not match deployment manifest"
    );
    anyhow::ensure!(
        anchor.governance_program_hash()
            == request.deployment.governance_program_hash().to_byte_array(),
        "bundled governance program does not match deployment manifest"
    );
    Ok(PreparedPolicy {
        sdk: SIGNER_SDK_VERSION,
        policy_root: policy.policy_digest(),
        verifier_program_hash: anchor.verifier_program_hash().into(),
        verifier_script_pubkey: anchor.script_pubkey().as_bytes().to_vec().try_into()?,
    })
}

pub fn protocol_for_deployment(
    deployment: &damp_core::registry::DeploymentManifest,
) -> anyhow::Result<Protocol> {
    anyhow::ensure!(
        deployment.contract_bundle_hash() == damp_core::CONTRACT_BUNDLE_HASH,
        "contract bundle does not match the current source"
    );
    Protocol::new(
        ProtocolConfig {
            regulated_asset: crate::utxo::asset_id(deployment.regulated_asset()),
            verifier_asset: crate::utxo::asset_id(deployment.verifier_asset()),
            verifier_asset_amount: deployment.verifier_asset_amount(),
            issuer: deployment.issuer_public_key().public_key(),
            network: deployment.network(),
        },
        damp_core::native_audit::AuditDomain::new(deployment.deployment_salt(), deployment.audit()),
    )
}
