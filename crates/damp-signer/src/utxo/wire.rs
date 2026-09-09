use damp_core::ledger::Txid;
use serde::{Deserialize, Serialize};

use crate::keys::{HolderKeyLocator, WalletKeyLocator};

/// Untrusted serialized input fields. Convert to `Utxo` before inspection or signing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UtxoFields {
    pub txid: Txid,
    pub vout: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_out: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction: Option<String>,
    pub spendable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_key: Option<WalletKeyLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder_key: Option<HolderKeyLocator>,
}
