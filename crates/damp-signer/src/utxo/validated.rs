use crate::keys::{HolderKeyLocator, WalletKeyLocator};
use elements::{OutPoint, TxOut, TxOutSecrets};

pub struct ValidatedUtxo {
    pub outpoint: OutPoint,
    pub txout: TxOut,
    pub(super) opening: TxOutSecrets,
    pub(super) ownership: crate::utxo::Ownership,
}

impl ValidatedUtxo {
    pub const fn opening(&self) -> &TxOutSecrets {
        &self.opening
    }
    pub const fn wallet_key(&self) -> Option<&WalletKeyLocator> {
        match &self.ownership {
            crate::utxo::Ownership::Wallet(key) => Some(key),
            _ => None,
        }
    }
    pub const fn holder_key(&self) -> Option<&HolderKeyLocator> {
        match &self.ownership {
            crate::utxo::Ownership::Holder(key) => Some(key),
            _ => None,
        }
    }
}

impl Drop for ValidatedUtxo {
    fn drop(&mut self) {
        crate::blinding::secrets::erase_opening(&mut self.opening);
    }
}

impl std::fmt::Debug for ValidatedUtxo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValidatedUtxo")
            .field("outpoint", &self.outpoint)
            .field("ownership", &self.ownership)
            .field("opening", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}
