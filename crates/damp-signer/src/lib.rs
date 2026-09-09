//! Construct and verify DAMP transactions with native and WebAssembly callers.

mod blinding;
mod covenant;
mod error;
mod signer;
pub mod transaction;
mod wasm;
pub use error::Error;
pub use signer::Signer;
pub mod audit;
pub mod keys;
pub mod network;
pub mod ops;
pub mod utxo;
pub mod wire;

use damp_core::CONTRACT_BUNDLE_HASH;
/// Wire identifier for signer responses.
pub const SIGNER_SDK_VERSION: &str = "simplicity-damp-signer/v0.1";
