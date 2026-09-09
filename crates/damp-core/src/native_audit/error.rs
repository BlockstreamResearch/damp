/// Failure to construct, verify or recover a native audit statement.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum AuditError {
    #[error(transparent)]
    Parse(#[from] crate::error::ParseError),
    #[error(transparent)]
    Encoding(#[from] ProofEncodingError),
    #[error("curve operation failed: {0}")]
    Curve(#[from] secp256k1_zkp::UpstreamError),
    #[error("invalid native point prefix")]
    NativePrefix,
    #[error("native point has a noncanonical x coordinate")]
    NativeCoordinate,
    #[error("native point is off curve")]
    NativePoint,
    #[error("audit blinder must be canonical and nonzero")]
    Blinder,
    #[error("audit amount outside native interval")]
    NativeAmount,
    #[error("opening does not match native commitment")]
    CommitmentMismatch,
    #[error("wrong native parity")]
    Parity,
    #[error("wrong native root")]
    Root,
    #[error("native commitment equation failed")]
    CommitmentEquation,
    #[error("native audit handle equation failed")]
    HandleEquation,
    #[error("wrong audit key epoch")]
    AuditKey,
    #[error("recovery record missing or unsupported")]
    RecoveryRecord,
    #[error("recovery record contains an invalid ephemeral key")]
    RecoveryKey,
    #[error("recovery encryption failed")]
    Encryption,
    #[error("recovery authentication failed")]
    Authentication,
    #[error("wrong recovery opening length")]
    RecoveryLength,
    #[error("recovered opening does not match native statement")]
    RecoveredOpening,
    #[error("DLP bound must be between 1 and 2^32")]
    RecoveryBound,
    #[error("DLP step is infinity")]
    SearchInfinity,
    #[error("DLP arithmetic overflow")]
    SearchArithmetic,
}

/// Malformed proof bytes, before statement-dependent verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProofEncodingError {
    #[error("audit proof must contain exactly 196 bytes")]
    Length,
    #[error("audit proof parity must be zero or one")]
    Parity,
    #[error("audit proof response is not a canonical scalar")]
    Scalar,
    #[error("audit proof root is not a canonical field element")]
    Root,
    #[error("audit proof contains an invalid curve point")]
    Point,
}
