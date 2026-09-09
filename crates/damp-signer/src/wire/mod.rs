//! JSON request and response adapters for native callers.

mod dispatch;
mod operation;
pub use crate::audit::credentials::execute as execute_audit_credentials;
pub use dispatch::{execute_native, export_audit_credentials_json};
pub use operation::Operation;
