//! Audit proofs bind native Elements commitments to an issuer recovery key.
//!
//! Parse the public statement and proof before verification. Recovery requires
//! the statement-bound result of verification. Missing recovery bytes do not
//! invalidate a proof. Secret arithmetic uses libsecp256k1; big integers process
//! only public point encodings.

mod error;
mod opening;
mod point;
mod proof;
mod recovery;
mod scalar;
mod statement;

pub use error::{AuditError, ProofEncodingError};
pub use opening::{AuditOpening, MAX_NATIVE_AUDIT_VALUE, NativeAuditAmount};
pub use proof::{NativeAuditProof, VerifiedAuditProof};
pub use recovery::{AuditSecret, RecoveryBound};
pub use statement::{
    AUXILIARY_BYTES, AuditDomain, AuditOutput, AuditStatement, AuxiliaryRecord, SigAllHash,
};
