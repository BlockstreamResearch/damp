use damp_core::policy::TreeDepth;
use damp_core::registry::{BlacklistEntry, DeploymentManifest};
use serde::Deserialize;
use simplicityhl::simplicity::Cmr;

use crate::audit::{RecoveryRequest, SignReportRequest};
use crate::keys::WalletKeyLocator;
use crate::ops::request::{
    BootstrapRequest, PolicyUpdateRequest, PreparePolicyRequest, ReissuanceRequest,
    SplitFundingRequest, TransferRequest,
};
use crate::utxo::input::Utxo;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransactionRequest {
    pub transaction: crate::transaction::TransactionRecord,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlacklistRequest {
    pub depth: TreeDepth,
    pub entries: Vec<BlacklistEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeafHashRequest {
    #[serde(deserialize_with = "parse_cmr")]
    pub cmr: Cmr,
}

fn parse_cmr<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<Cmr, D::Error> {
    let text = String::deserialize(decoder)?;
    let cmr: Cmr = text.parse().map_err(serde::de::Error::custom)?;
    if cmr.to_string() != text {
        return Err(serde::de::Error::custom(
            "commitment root must be 32-byte lowercase hex",
        ));
    }
    Ok(cmr)
}

/// The native JSON adapter selects an operation before calling the typed signer.
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    content = "request",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum Operation {
    InspectPublicTransaction(TransactionRequest),
    BuildBlacklist(BlacklistRequest),
    SignAuditReport(Box<SignReportRequest>),
    AuditLeafHash(LeafHashRequest),
    RecoverAudit(Box<RecoveryRequest>),
    WalletAddress(WalletKeyLocator),
    HolderAddress(Box<DeploymentManifest>),
    Bootstrap(Box<BootstrapRequest>),
    Transfer(Box<TransferRequest>),
    Reissue(Box<ReissuanceRequest>),
    PolicyUpdate(Box<PolicyUpdateRequest>),
    PreparePolicy(Box<PreparePolicyRequest>),
    Inspect(Vec<Utxo>),
    SplitFunding(SplitFundingRequest),
}

impl Operation {
    pub const fn name(&self) -> &'static str {
        match self {
            Self::InspectPublicTransaction(_) => "inspect-public-transaction",
            Self::BuildBlacklist(_) => "build-blacklist",
            Self::SignAuditReport(_) => "sign-audit-report",
            Self::AuditLeafHash(_) => "audit-leaf-hash",
            Self::RecoverAudit(_) => "recover-audit",
            Self::WalletAddress(_) => "wallet-address",
            Self::HolderAddress(_) => "holder-address",
            Self::Bootstrap(_) => "bootstrap",
            Self::Transfer(_) => "transfer",
            Self::Reissue(_) => "reissue",
            Self::PolicyUpdate(_) => "policy-update",
            Self::PreparePolicy(_) => "prepare-policy",
            Self::Inspect(_) => "inspect",
            Self::SplitFunding(_) => "split-funding",
        }
    }

    /// Parse the operation and its complete request. Missing fields have no defaults.
    ///
    /// # Errors
    /// Rejects unknown operations, malformed fields and invalid domain values.
    pub fn parse(name: &str, request: serde_json::Value) -> Result<Self, crate::Error> {
        Ok(serde_json::from_value(
            serde_json::json!({"operation": name, "request": request}),
        )?)
    }
}

impl std::fmt::Debug for Operation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Operation")
            .field("name", &self.name())
            .finish_non_exhaustive()
    }
}
