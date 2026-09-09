#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RegistryError {
    #[error("policy sequence and parent fields are inconsistent or exceed the JSON integer limit")]
    Parent,
    #[error("blacklist entries must be strictly ordered by transaction id and output index")]
    EntryOrder,
    #[error("blacklist note exceeds 280 UTF-8 bytes")]
    EntryNote,
    #[error("policy {field} does not match its entries")]
    Commitment { field: &'static str },
    #[error("invalid policy set: {0}")]
    Policy(#[source] crate::policy::PolicyError),
    #[error("unsupported registry schema")]
    Schema,
    #[error("unsupported protocol")]
    Protocol,
    #[error("the verifier anchor requires one unit")]
    AnchorQuantity,
    #[error("policy, regulated and verifier assets must be distinct")]
    AssetCollision,
    #[error("reissuance token and entropy must exist exactly for issuer-managed supply")]
    SupplyConfiguration,
}
