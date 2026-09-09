/// Errors at the native signer and wire boundaries.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error(transparent)]
    Parse(#[from] damp_core::error::ParseError),
    #[error(transparent)]
    Policy(#[from] damp_core::policy::PolicyError),
    #[error(transparent)]
    Recovery(#[from] crate::audit::RecoveryError),
    #[error(transparent)]
    Network(#[from] crate::network::NetworkMismatch),
    #[error("key role must be holder, issuer, audit or report")]
    KeyRole,
    #[error("invalid signer mnemonic")]
    Mnemonic,
    #[error("invalid operation request: {0}")]
    Request(#[from] serde_json::Error),
    #[error("key derivation failed: {0}")]
    Derivation(#[source] anyhow::Error),
    #[error("{operation} failed: {source}")]
    Operation {
        operation: &'static str,
        #[source]
        source: anyhow::Error,
    },
}

impl Error {
    pub(crate) fn operation(operation: &'static str, source: anyhow::Error) -> Self {
        Self::Operation { operation, source }
    }
}
