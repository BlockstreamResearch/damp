use damp_core::{
    ledger::{Outpoint, ScriptPubkey, Txid},
    native_audit::NativeAuditAmount,
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuxiliaryFailure {
    Missing,
    Invalid,
}

/// Recovery availability is separate from the already verified covenant and proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryOutcome {
    Authenticated {
        amount: NativeAuditAmount,
    },
    Bounded {
        amount: NativeAuditAmount,
        auxiliary: AuxiliaryFailure,
    },
    Exhausted {
        auxiliary: AuxiliaryFailure,
    },
    Unavailable {
        auxiliary: AuxiliaryFailure,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryStatus {
    Recovered,
    RecoveredByBoundedDlp,
    BoundedDlpExhausted,
    RecoveryRequired,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuxiliaryStatus {
    Valid,
    Missing,
    Invalid,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplicationBounds {
    WithinApplicationCap,
    OutsideApplicationCap,
    Unknown,
}

impl RecoveryOutcome {
    pub const fn amount(self) -> Option<NativeAuditAmount> {
        match self {
            Self::Authenticated { amount } | Self::Bounded { amount, .. } => Some(amount),
            Self::Exhausted { .. } | Self::Unavailable { .. } => None,
        }
    }
    pub const fn status(self) -> RecoveryStatus {
        match self {
            Self::Authenticated { .. } => RecoveryStatus::Recovered,
            Self::Bounded { .. } => RecoveryStatus::RecoveredByBoundedDlp,
            Self::Exhausted { .. } => RecoveryStatus::BoundedDlpExhausted,
            Self::Unavailable { .. } => RecoveryStatus::RecoveryRequired,
        }
    }
    pub const fn auxiliary_status(self) -> AuxiliaryStatus {
        let failure = match self {
            Self::Authenticated { .. } => return AuxiliaryStatus::Valid,
            Self::Bounded { auxiliary, .. }
            | Self::Exhausted { auxiliary }
            | Self::Unavailable { auxiliary } => auxiliary,
        };
        match failure {
            AuxiliaryFailure::Missing => AuxiliaryStatus::Missing,
            AuxiliaryFailure::Invalid => AuxiliaryStatus::Invalid,
        }
    }
    pub fn application_bounds(self) -> ApplicationBounds {
        match self.amount() {
            Some(value) if value.application_amount().is_some() => {
                ApplicationBounds::WithinApplicationCap
            }
            Some(_) => ApplicationBounds::OutsideApplicationCap,
            None => ApplicationBounds::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveredOutput {
    outpoint: Outpoint,
    outcome: RecoveryOutcome,
    script_pubkey: ScriptPubkey,
}
impl RecoveredOutput {
    pub(super) fn new(
        outpoint: Outpoint,
        outcome: RecoveryOutcome,
        script_pubkey: ScriptPubkey,
    ) -> Self {
        Self {
            outpoint,
            outcome,
            script_pubkey,
        }
    }
    pub const fn outpoint(&self) -> Outpoint {
        self.outpoint
    }
    pub const fn outcome(&self) -> RecoveryOutcome {
        self.outcome
    }
    pub const fn script_pubkey(&self) -> &ScriptPubkey {
        &self.script_pubkey
    }
}
impl Serialize for RecoveredOutput {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields<'a> {
            outpoint: Outpoint,
            amount: Option<NativeAuditAmount>,
            recovery_status: RecoveryStatus,
            auxiliary_status: AuxiliaryStatus,
            application_bounds: ApplicationBounds,
            script_pubkey: &'a ScriptPubkey,
        }
        Fields {
            outpoint: self.outpoint,
            amount: self.outcome.amount(),
            recovery_status: self.outcome.status(),
            auxiliary_status: self.outcome.auxiliary_status(),
            application_bounds: self.outcome.application_bounds(),
            script_pubkey: &self.script_pubkey,
        }
        .serialize(serializer)
    }
}

/// Recovery rows from a locally executed covenant. Chain inclusion remains unverified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryResult {
    transaction_id: Txid,
    outputs: Vec<RecoveredOutput>,
}
impl RecoveryResult {
    pub(super) fn new(transaction_id: Txid, outputs: Vec<RecoveredOutput>) -> Self {
        Self {
            transaction_id,
            outputs,
        }
    }
    pub const fn transaction_id(&self) -> Txid {
        self.transaction_id
    }
    pub fn outputs(&self) -> &[RecoveredOutput] {
        &self.outputs
    }
}
impl Serialize for RecoveryResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields<'a> {
            transaction_id: Txid,
            covenant_verified: bool,
            chain_inclusion: &'static str,
            outputs: &'a [RecoveredOutput],
        }
        Fields {
            transaction_id: self.transaction_id,
            covenant_verified: true,
            chain_inclusion: "requires-independent-chain-verification",
            outputs: &self.outputs,
        }
        .serialize(serializer)
    }
}
