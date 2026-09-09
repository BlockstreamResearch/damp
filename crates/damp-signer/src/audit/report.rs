use crate::keys;
use damp_core::registry::DeploymentManifest;
use elements::secp256k1_zkp::{Keypair, Message, Secp256k1};
use lwk_signer::SwSigner;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignReportRequest {
    pub deployment: DeploymentManifest,
    pub report_json: String,
}
pub(crate) fn sign_report(
    signer: &SwSigner,
    request: SignReportRequest,
) -> anyhow::Result<serde_json::Value> {
    let id = request.deployment.deployment_id();
    anyhow::ensure!(request.report_json.len() <= 4_000_000, "report too large");
    let value: serde_json::Value = serde_json::from_str(&request.report_json)?;
    anyhow::ensure!(
        value["deploymentId"] == id.to_string()
            && value["network"].as_str() == Some(request.deployment.network().as_str()),
        "report deployment mismatch"
    );
    let index =
        keys::derive_key_index(&request.deployment.deployment_salt(), keys::KeyRole::Issuer)?;
    let (_, key) = keys::derive_xprv(signer, keys::KeyRole::Issuer, index)?;
    anyhow::ensure!(
        keys::xonly_from_xprv(&key) == request.deployment.issuer_public_key().public_key(),
        "issuer signing key unavailable"
    );
    let digest = super::signature::digest(&request.report_json);
    let mut pair = Keypair::from_secret_key(&Secp256k1::new(), &key.secret_key());
    let signature = Secp256k1::new().sign_schnorr(&Message::from_digest(digest), &pair);
    pair.non_secure_erase();
    Ok(
        serde_json::json!({"algorithm":"BIP340-SHA256-DAMP-report-v2","digest":hex::encode(digest),"signature":signature.to_string(),"publicKey":request.deployment.issuer_public_key()}),
    )
}
