//! Recover from a locally executed transaction witness without claiming chain inclusion.

mod engine;
mod error;
mod request;
mod result;
mod witness;

pub(crate) use engine::{recover, recover_key};
pub use error::RecoveryError;
pub use request::RecoveryRequest;
pub use result::{
    ApplicationBounds, AuxiliaryFailure, AuxiliaryStatus, RecoveredOutput, RecoveryOutcome,
    RecoveryResult, RecoveryStatus,
};
