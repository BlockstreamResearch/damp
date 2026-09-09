use damp_core::ledger::{Outpoint, Txid};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RecoveryError {
    #[error(transparent)]
    Native(#[from] damp_core::native_audit::AuditError),
    #[error(transparent)]
    Parse(#[from] damp_core::error::ParseError),
    #[error("recovery transaction exceeds the 400000-byte limit")]
    TransactionSize,
    #[error("recovery requires at most 256 parent transactions")]
    ParentCount,
    #[error("duplicate parent transaction {0}")]
    DuplicateParent(Txid),
    #[error("parent transaction unavailable for {0}; recovery data not evaluated")]
    MissingParent(Outpoint),
    #[error("parent output does not exist: {0}")]
    ParentOutput(Outpoint),
    #[error("policy deployment mismatch")]
    PolicyDeployment,
    #[error("audit key derivation failed: {0}")]
    KeyDerivation(#[source] anyhow::Error),
    #[error("audit verifier construction failed: {0}")]
    VerifierConstruction(#[source] anyhow::Error),
    #[error("audit covenant verification failed: {0}")]
    CovenantVerification(#[source] anyhow::Error),
    #[error("expected one canonical audit-record witness")]
    WitnessCount,
    #[error("truncated audit witness")]
    TruncatedWitness,
    #[error("unused audit witness bits")]
    TrailingWitness,
    #[error("audit output {0} does not exist")]
    OutputIndex(u32),
    #[error("audit output {0} has a missing or incorrect native range proof")]
    RangeProof(u32),
    #[error("audit output {0} is not confidential")]
    ExplicitValue(u32),
}
