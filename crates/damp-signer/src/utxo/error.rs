#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum UtxoError {
    #[error("an input needs exactly one serialized output or parent transaction")]
    Source,
    #[error("an input cannot have both wallet and holder key locators")]
    Ownership,
    #[error("invalid {field} encoding")]
    Encoding { field: &'static str },
    #[error("parent transaction id does not match the selected outpoint")]
    ParentId,
    #[error("selected output index is outside the parent transaction")]
    OutputIndex,
}
