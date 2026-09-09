//! Deployment and wallet key derivation.

mod address;
pub mod info;
mod locator;
mod ownership;
pub use address::{AddressError, ConfidentialAddress};
pub use holder::HolderRecipient;
pub use locator::{KeyIndex, KeyRole, WalletBranch};
pub use ownership::{HolderKeyLocator, WalletKeyLocator};
pub(crate) mod derive;
pub(crate) mod holder;
pub(crate) mod wallet;
pub(crate) use derive::{
    derive_key_index, derive_wallet_address, derive_xprv, signer_descriptor, xonly_from_xprv,
};
