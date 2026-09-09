use damp_core::ledger::XOnlyKey;
use serde::{Deserialize, Serialize};

use super::{KeyIndex, WalletBranch};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletKeyLocator {
    pub branch: WalletBranch,
    pub index: KeyIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HolderKeyLocator {
    pub derivation_index: KeyIndex,
    pub owner_public_key: XOnlyKey,
}
