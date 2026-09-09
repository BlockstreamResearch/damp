//! Deployment-scoped audit credentials contain no mnemonic or spending key.
//! Issuer openings are exported offline; the report key is issuer-certified.
use crate::audit::{recovery, report};
use crate::keys::holder as receive;
use crate::{keys, network::DeploymentNetwork};
use damp_core::registry::DeploymentManifest;

use super::signature::digest;
use anyhow::Context;
use elements::{
    Transaction,
    secp256k1_zkp::{
        Generator, Keypair, Message, PedersenCommitment, Secp256k1, SecretKey, Tweak,
        XOnlyPublicKey, schnorr::Signature,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::str::FromStr;
use zeroize::Zeroize;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credentials {
    schema: String,
    deployment: DeploymentManifest,
    audit_secret: String,
    report_secret: String,
    certificate_json: String,
    certificate_signature: String,
    holder_address: Value,
    issuer_openings: Vec<Opening>,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.audit_secret.zeroize();
        self.report_secret.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Opening {
    outpoint: String,
    amount: String,
    blinder: String,
}
impl Drop for Opening {
    fn drop(&mut self) {
        self.amount.zeroize();
        self.blinder.zeroize();
    }
}
struct Secret(SecretKey);
impl Drop for Secret {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}
fn verify(text: &str, signature: &str, key: &str) -> anyhow::Result<()> {
    Ok(Secp256k1::verification_only().verify_schnorr(
        &Signature::from_str(signature)?,
        &Message::from_digest(digest(text)),
        &XOnlyPublicKey::from_str(key)?,
    )?)
}

pub(crate) fn export_json(
    signer: &lwk_signer::SwSigner,
    network: DeploymentNetwork,
    request: Value,
) -> anyhow::Result<zeroize::Zeroizing<String>> {
    let deployment: DeploymentManifest = serde_json::from_value(request["deployment"].clone())?;
    let id = deployment.deployment_id();
    crate::network::require_network(network, deployment.network())?;
    let audit = &deployment.audit();
    let (_, audit_key) = keys::derive_xprv(
        signer,
        crate::keys::KeyRole::Audit,
        keys::derive_key_index(&deployment.deployment_salt(), crate::keys::KeyRole::Audit)?,
    )?;
    anyhow::ensure!(
        audit_key.secret_key().public_key(&Secp256k1::new()) == audit.public_key.public_key(),
        "wrong audit issuer"
    );
    let (_, report_key) = keys::derive_xprv(
        signer,
        crate::keys::KeyRole::Report,
        keys::derive_key_index(&deployment.deployment_salt(), crate::keys::KeyRole::Report)?,
    )?;
    let holder = receive::derive_holder_address(signer, network, &deployment)?;
    let (_, holder_key) = keys::derive_xprv(
        signer,
        crate::keys::KeyRole::Holder,
        holder.derivation_index,
    )?;
    let report_public = keys::xonly_from_xprv(&report_key).to_string();
    let certificate_json = serde_json::to_string(
        &json!({"schema":"damp-audit-report-authorization/v1","deploymentId":id,"network":deployment.network().as_str(),"reportPublicKey":report_public,"issuerPublicKey":deployment.issuer_public_key(),"auditPublicKey":audit.public_key}),
    )?;
    let signature = report::sign_report(
        signer,
        report::SignReportRequest {
            deployment: deployment.clone(),
            report_json: certificate_json.clone(),
        },
    )?;
    let mut openings = Vec::new();
    let transactions = request["issuerTransactions"]
        .as_array()
        .context("issuerTransactions required (may be empty)")?;
    anyhow::ensure!(transactions.len() <= 1024, "too many issuer transactions");
    for raw in transactions {
        let tx: Transaction = elements::encode::deserialize(&hex::decode(
            raw.as_str().context("transaction hex required")?,
        )?)?;
        for (index, out) in tx.output.iter().enumerate() {
            if hex::encode(out.script_pubkey.as_bytes()) != holder.script_pubkey
                || out.asset.explicit() != Some(crate::utxo::asset_id(deployment.regulated_asset()))
                || !out.value.is_confidential()
            {
                continue;
            }
            let mut secret = crate::transaction::unblind_value_only(
                out,
                crate::utxo::asset_id(deployment.regulated_asset()),
                holder_key.secret_key(),
            )?;
            openings.push(Opening {
                outpoint: format!("{}:{index}", tx.txid()),
                amount: secret.value.to_string(),
                blinder: hex::encode(secret.value_bf.into_inner().as_ref()),
            });
            crate::blinding::secrets::erase_opening(&mut secret);
        }
    }
    Ok(zeroize::Zeroizing::new(serde_json::to_string(
        &Credentials {
            schema: "damp-audit-credentials/v1".into(),
            deployment,
            audit_secret: hex::encode(audit_key.secret_key().secret_bytes()),
            report_secret: hex::encode(report_key.secret_key().secret_bytes()),
            certificate_json,
            certificate_signature: signature["signature"]
                .as_str()
                .context("signature missing")?
                .into(),
            holder_address: serde_json::to_value(holder)?,
            issuer_openings: openings,
        },
    )?))
}

pub fn execute(
    credentials_json: &str,
    network: DeploymentNetwork,
    operation: &str,
    request: Value,
) -> anyhow::Result<Value> {
    let credentials: Credentials = serde_json::from_str(credentials_json)?;
    anyhow::ensure!(
        credentials.schema == "damp-audit-credentials/v1",
        "invalid credential schema"
    );
    let id = credentials.deployment.deployment_id();
    crate::network::require_network(network, credentials.deployment.network())?;
    let certificate: Value = serde_json::from_str(&credentials.certificate_json)?;
    verify(
        &credentials.certificate_json,
        &credentials.certificate_signature,
        &credentials.deployment.issuer_public_key().to_string(),
    )?;
    anyhow::ensure!(
        certificate["schema"] == "damp-audit-report-authorization/v1"
            && certificate["deploymentId"] == id.to_string()
            && certificate["network"] == credentials.deployment.network().as_str()
            && certificate["issuerPublicKey"]
                == credentials.deployment.issuer_public_key().to_string()
            && certificate["auditPublicKey"]
                == credentials.deployment.audit().public_key.to_string(),
        "credential authorization mismatch"
    );
    if let Some(deployment) = request.get("deployment") {
        anyhow::ensure!(
            serde_json::from_value::<DeploymentManifest>(deployment.clone())?.deployment_id() == id,
            "credential deployment mismatch"
        );
    }
    match operation {
        "inspect-public-transaction" => Ok(serde_json::to_value(
            crate::Signer::inspect_public_transaction(
                &request["transaction"]
                    .as_str()
                    .context("transaction required")?
                    .parse()?,
            ),
        )?),
        "validate-policy" => {
            let policy: damp_core::registry::PolicySnapshot = serde_json::from_value(request)?;
            anyhow::ensure!(policy.deployment_id() == id, "policy scope mismatch");
            policy.tree();
            Ok(json!({"valid":true}))
        }
        "prepare-policy" => Ok(serde_json::to_value(
            crate::covenant::policy::prepare_policy(serde_json::from_value(request)?)?,
        )?),
        "audit-leaf-hash" => {
            let cmr = hex::decode(request["cmr"].as_str().context("cmr required")?)?;
            anyhow::ensure!(cmr.len() == 32, "invalid cmr");
            let cmr = simplicityhl::simplicity::Cmr::from_byte_array(cmr.try_into().unwrap());
            Ok(json!({"hash": crate::covenant::program::leaf_hash(cmr).to_string()}))
        }
        "holder-address" => {
            anyhow::ensure!(
                serde_json::from_value::<DeploymentManifest>(request)?.deployment_id() == id,
                "credential deployment mismatch"
            );
            Ok(credentials.holder_address.clone())
        }
        "recover-audit" => {
            let secret = Secret(SecretKey::from_str(&credentials.audit_secret)?);
            Ok(serde_json::to_value(recovery::recover_key(
                &secret.0,
                &serde_json::from_value(request)?,
            )?)?)
        }
        "issuer-opening" => {
            let tx: Transaction = elements::encode::deserialize(&hex::decode(
                request["transaction"]
                    .as_str()
                    .context("transaction required")?,
            )?)?;
            let index = usize::try_from(request["index"].as_u64().context("index required")?)?;
            let out = tx.output.get(index).context("output missing")?;
            let record = credentials
                .issuer_openings
                .iter()
                .find(|o| o.outpoint == format!("{}:{index}", tx.txid()))
                .context("issuer opening unavailable; export refreshed credentials offline")?;
            let asset = crate::utxo::asset_id(credentials.deployment.regulated_asset());
            anyhow::ensure!(
                out.asset.explicit() == Some(asset),
                "opening asset mismatch"
            );
            let bytes = zeroize::Zeroizing::new(hex::decode(&record.blinder)?);
            let mut blinder = Tweak::from_slice(&bytes)?;
            let commitment = PedersenCommitment::new(
                &Secp256k1::new(),
                record.amount.parse()?,
                blinder,
                Generator::new_unblinded(&Secp256k1::new(), asset.into_tag()),
            );
            // SAFETY: blinder is an owned, valid Tweak; overwrite it with the valid zero tweak.
            unsafe {
                std::ptr::write_volatile(&mut blinder, Tweak::from_slice(&[0; 32])?);
            }
            anyhow::ensure!(
                out.value.commitment() == Some(commitment),
                "issuer opening does not match commitment"
            );
            Ok(json!({"amount":record.amount}))
        }
        "sign-audit-report" => {
            let text = request["reportJson"]
                .as_str()
                .context("report JSON required")?;
            anyhow::ensure!(text.len() <= 4_000_000, "report too large");
            let report: Value = serde_json::from_str(text)?;
            anyhow::ensure!(
                report["deploymentId"] == id.to_string()
                    && report["network"] == credentials.deployment.network().as_str(),
                "report scope mismatch"
            );
            let secret = Secret(SecretKey::from_str(&credentials.report_secret)?);
            let mut pair = Keypair::from_secret_key(&Secp256k1::new(), &secret.0);
            let public = pair.x_only_public_key().0.to_string();
            anyhow::ensure!(
                certificate["reportPublicKey"] == public,
                "report key is not authorized"
            );
            let signature =
                Secp256k1::new().sign_schnorr(&Message::from_digest(digest(text)), &pair);
            pair.non_secure_erase();
            Ok(
                json!({"algorithm":"BIP340-SHA256-DAMP-report-v2","publicKey":public,"signature":signature.to_string(),"certificateJson":credentials.certificate_json,"certificateSignature":credentials.certificate_signature}),
            )
        }
        _ => anyhow::bail!("operation unavailable to audit credentials"),
    }
}
