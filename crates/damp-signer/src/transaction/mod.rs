//! Final transaction checks and PSET assembly.

mod amounts;
mod fee;
mod inspection;
mod pset;
mod record;
pub(crate) mod wire;
pub(crate) use inspection::inspect;
pub use inspection::{PublicInput, PublicIssuance, PublicOutput, PublicTransaction};
pub use record::{TransactionEncodingError, TransactionRecord};

pub(crate) use crate::keys::wallet::{add_wallet_metadata, wallet_address};
pub(crate) use crate::utxo::selection::{
    input_needs_confidential_change, select_fee_funding, select_smallest_sufficient,
};
pub(crate) use crate::utxo::unblind::unblind_value_only;
pub(crate) use crate::utxo::validated::ValidatedUtxo;
pub(crate) use crate::utxo::validation::{
    decode_confidential_wallet_utxo, decode_utxo, inspect_utxos,
};
pub(crate) use amounts::{
    MAX_EXPLICIT_MONEY, transaction_surjection_domain, verify_transaction_amounts,
};
pub(crate) use fee::validate_network_fee;
pub(crate) use pset::{
    add_validated_input, finalize_lwk_wallet_inputs, set_lwk_genesis_hash, set_lwk_genesis_hash_for,
};
