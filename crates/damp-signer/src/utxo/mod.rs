//! Parse, inspect and select transaction inputs.

mod error;
pub mod input;
pub(crate) mod selection;
pub(crate) mod unblind;
pub(crate) mod validated;
pub(crate) mod validation;
pub mod wire;
pub use error::UtxoError;
pub use input::{InputSource, InputStatus, InspectedUtxo, Ownership, Utxo};

pub(crate) fn asset_id(value: damp_core::ledger::AssetId) -> elements::AssetId {
    elements::AssetId::from_byte_array(value.to_consensus_byte_array())
}

pub(crate) fn public_asset_id(value: elements::AssetId) -> damp_core::ledger::AssetId {
    damp_core::ledger::AssetId::from_consensus_byte_array(value.into_inner().to_byte_array())
}
