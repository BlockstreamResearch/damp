//! Persistent public history. Recovery and report signing belong to the caller.
#![forbid(unsafe_code)]

mod cancellation;
mod encoding;
mod error;
mod private;
mod reorg;
mod scan;
mod store;
pub mod token;
mod transaction;
mod types;
mod view;

pub use cancellation::Cancellation;
pub use damp_core::ledger::{Outpoint, Txid};
pub use damp_signer::transaction::TransactionRecord;
pub use elements::BlockHash;
pub use error::{Error, Result};
pub use scan::{Budget, Progress, Provider};
pub use store::HistoryIndex;
pub use transaction::IndexedTransaction;
pub use types::{Scope, Snapshot};
pub use view::SnapshotView;
