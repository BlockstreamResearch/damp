use std::str::FromStr;

use amp_core::policy::{NonMembershipProof, SetCommitment, decode_hex_32};
use elements::hashes::Hash as _;
use elements::{AssetId, OutPoint, schnorr::XOnlyPublicKey};

use crate::model::{PreparePolicyRequest, PreparedPolicy, SIGNER_SDK_VERSION};
use crate::protocol::{Protocol, ProtocolConfig};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedInputPolicyProof {
    pub input_index: u32,
    pub proof: NonMembershipProof,
}

impl IndexedInputPolicyProof {
    #[must_use]
    pub const fn new(input_index: u32, proof: NonMembershipProof) -> Self {
        Self { input_index, proof }
    }
}

#[must_use]
pub fn outpoint_key(outpoint: OutPoint) -> [u8; 32] {
    amp_core::policy::outpoint_key_bytes(outpoint.txid.to_byte_array(), outpoint.vout)
}

pub fn prepare_policy(request: PreparePolicyRequest) -> anyhow::Result<PreparedPolicy> {
    request.deployment.validate()?;
    let policy = SetCommitment {
        root: decode_hex_32("set root", &request.set_root)?,
        count: request.entry_count,
        depth: request.tree_depth,
    };
    anyhow::ensure!(
        usize::try_from(policy.count)? <= policy.depth.capacity(),
        "policy entry count exceeds depth capacity"
    );
    let protocol = protocol_for_deployment(&request.deployment)?;
    let anchor = protocol.anchor(policy)?;
    anyhow::ensure!(
        hex::encode(protocol.user_executable_leaf_hash()) == request.deployment.user_program_hash,
        "bundled user program does not match deployment manifest"
    );
    anyhow::ensure!(
        hex::encode(anchor.governance_program_hash()) == request.deployment.governance_program_hash,
        "bundled governance program does not match deployment manifest"
    );
    Ok(PreparedPolicy {
        sdk: SIGNER_SDK_VERSION,
        policy_root: hex::encode(policy.policy_digest()),
        verifier_program_hash: hex::encode(anchor.verifier_program_hash()),
        verifier_script_pubkey: hex::encode(anchor.script_pubkey().as_bytes()),
    })
}

pub fn protocol_for_deployment(
    deployment: &amp_core::registry::DeploymentManifestV1,
) -> anyhow::Result<Protocol> {
    Protocol::new(ProtocolConfig {
        regulated_asset: AssetId::from_str(&deployment.regulated_asset)?,
        verifier_asset: AssetId::from_str(&deployment.verifier_asset)?,
        verifier_asset_amount: deployment.verifier_asset_amount,
        issuer: XOnlyPublicKey::from_str(&deployment.issuer_public_key)?,
        network: deployment.network,
    })
}
