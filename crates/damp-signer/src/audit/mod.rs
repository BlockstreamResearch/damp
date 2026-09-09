//! Recover confidential output amounts and authenticate signed reports.

pub(crate) mod credentials;
pub(crate) mod recovery;
pub(crate) mod report;
pub(crate) mod signature;
pub use recovery::{
    ApplicationBounds, AuxiliaryFailure, AuxiliaryStatus, RecoveredOutput, RecoveryError,
    RecoveryOutcome, RecoveryRequest, RecoveryResult, RecoveryStatus,
};
pub use report::SignReportRequest;
pub use signature::verify_report;
