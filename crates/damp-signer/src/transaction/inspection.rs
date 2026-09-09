use damp_core::ledger::{AssetId, ConsensusTxid, Outpoint, Txid};
use elements::{Script, hashes::Hash as _};
use serde::Serialize;

use super::{TransactionRecord, wire};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicIssuance {
    pub asset: AssetId,
    pub token: AssetId,
    #[serde(serialize_with = "wire::optional_decimal")]
    pub amount: Option<u64>,
    pub reissuance: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicInput {
    pub outpoint: Outpoint,
    pub issuance: Option<PublicIssuance>,
    #[serde(serialize_with = "wire::optional_hex")]
    pub leaf: Option<Vec<u8>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicOutput {
    pub outpoint: Outpoint,
    pub asset: Option<AssetId>,
    #[serde(serialize_with = "wire::optional_decimal")]
    pub amount: Option<u64>,
    #[serde(serialize_with = "wire::hex_script")]
    pub script_pubkey: Script,
    pub unspendable: bool,
}
/// Public transaction fields without recovered openings or wallet metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublicTransaction {
    pub txid: Txid,
    pub inputs: Vec<PublicInput>,
    pub outputs: Vec<PublicOutput>,
}

pub(crate) fn inspect(record: &TransactionRecord) -> PublicTransaction {
    let tx = record.transaction();
    let inputs = tx
        .input
        .iter()
        .map(|input| {
            let issuance = if input.has_issuance() {
                let (asset, token) = input.issuance_ids();
                Some(PublicIssuance {
                    asset: crate::utxo::public_asset_id(asset),
                    token: crate::utxo::public_asset_id(token),
                    amount: input.asset_issuance.amount.explicit(),
                    reissuance: input.asset_issuance.asset_blinding_nonce
                        != elements::secp256k1_zkp::ZERO_TWEAK,
                })
            } else {
                None
            };
            PublicInput {
                outpoint: Outpoint::new(
                    ConsensusTxid::from(input.previous_output.txid.to_byte_array()).into(),
                    input.previous_output.vout,
                ),
                issuance,
                leaf: input.witness.script_witness.get(2).cloned(),
            }
        })
        .collect();
    let outputs = tx
        .output
        .iter()
        .enumerate()
        .map(|(index, output)| PublicOutput {
            // The encoded transaction size bounds the number of outputs below u32::MAX.
            outpoint: Outpoint::new(record.txid(), index as u32),
            asset: output.asset.explicit().map(crate::utxo::public_asset_id),
            amount: output.value.explicit(),
            script_pubkey: output.script_pubkey.clone(),
            unspendable: output.script_pubkey.is_provably_unspendable(),
        })
        .collect();
    PublicTransaction {
        txid: record.txid(),
        inputs,
        outputs,
    }
}
