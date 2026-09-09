use super::Operation;
use crate::audit::{credentials as audit_credentials, report};
use crate::covenant::program as protocol;
use crate::network::DeploymentNetwork;
use crate::{Error, Signer};
use lwk_signer::SwSigner;

/// Decode JSON once, then execute the selected typed operation.
///
/// # Errors
/// Rejects malformed requests before constructing the signer. Operation failures
/// preserve the operation name and the underlying validation error.
pub fn execute_native(
    mnemonic: &str,
    network: DeploymentNetwork,
    operation: &str,
    request: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let operation = Operation::parse(operation, request)?;
    let signer = Signer::new(mnemonic, network)?;
    Ok(match operation {
        Operation::InspectPublicTransaction(request) => {
            serde_json::to_value(Signer::inspect_public_transaction(&request.transaction))?
        }
        Operation::BuildBlacklist(request) => serde_json::to_value(
            crate::ops::policy::build_blacklist(request.depth, request.entries)?,
        )?,
        Operation::SignAuditReport(request) => report::sign_report(&signer.inner, *request)
            .map_err(|error| Error::operation("report signing", error))?,
        Operation::AuditLeafHash(request) => {
            serde_json::json!({"hash":protocol::leaf_hash(request.cmr).to_string()})
        }
        Operation::RecoverAudit(request) => serde_json::to_value(signer.recover_audit(&request)?)?,
        Operation::WalletAddress(request) => {
            serde_json::to_value(signer.wallet_address(request.branch, request.index)?)?
        }
        Operation::HolderAddress(request) => {
            serde_json::to_value(signer.holder_address(&request)?)?
        }
        Operation::Bootstrap(request) => serde_json::to_value(signer.bootstrap(*request)?)?,
        Operation::Transfer(request) => serde_json::to_value(signer.transfer(*request)?)?,
        Operation::Reissue(request) => serde_json::to_value(signer.reissue(*request)?)?,
        Operation::PolicyUpdate(request) => serde_json::to_value(signer.update_policy(*request)?)?,
        Operation::PreparePolicy(request) => {
            serde_json::to_value(Signer::prepare_policy(*request)?)?
        }
        Operation::Inspect(request) => serde_json::to_value(signer.inspect(&request)?)?,
        Operation::SplitFunding(request) => serde_json::to_value(signer.split_funding(request)?)?,
    })
}

/// Export deployment-scoped audit/report credentials without retaining the
/// serialized secret buffer after the caller writes it to its protected file.
pub fn export_audit_credentials_json(
    mnemonic: &str,
    network: DeploymentNetwork,
    request: serde_json::Value,
) -> anyhow::Result<zeroize::Zeroizing<String>> {
    let signer = SwSigner::new(mnemonic, false)?;
    audit_credentials::export_json(&signer, network, request)
}
