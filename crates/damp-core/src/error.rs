//! Errors at the boundary between encoded input and domain values.

/// A value could not be represented by the requested domain type.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    #[error("deployment salt must be nonzero")]
    ZeroSalt,
    #[error("{field} must be {bytes}-byte lowercase hex")]
    Hex { field: &'static str, bytes: usize },
    #[error("{field} is not a valid curve point")]
    CurvePoint { field: &'static str },
    #[error("amount must be canonical decimal in 1..=18446744073709551615")]
    Amount,
    #[error("{field} must be in {minimum}..={maximum}")]
    Bound {
        field: &'static str,
        minimum: u64,
        maximum: u64,
    },
    #[error("outpoint must be a lowercase transaction id and canonical u32 index separated by ':'")]
    Outpoint,
    #[error("{field} must have {minimum}..={maximum} UTF-8 bytes and no surrounding whitespace")]
    Text {
        field: &'static str,
        minimum: usize,
        maximum: usize,
    },
    #[error("script must be nonempty lowercase hex")]
    Script,
}
