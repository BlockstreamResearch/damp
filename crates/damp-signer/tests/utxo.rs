use damp_core::ledger::{ConsensusTxid, Outpoint};
use elements::confidential::{Asset, Nonce, Value};
use elements::hashes::Hash as _;
use elements::{AssetId, Script, Transaction, TxOut, TxOutWitness};
use serde_json::json;
use simplicity_damp_signer::utxo::{InputSource, InputStatus, Ownership, Utxo, UtxoError};

fn parent() -> Transaction {
    Transaction {
        version: 2,
        lock_time: elements::LockTime::ZERO,
        input: vec![],
        output: vec![TxOut {
            asset: Asset::Explicit(AssetId::from_byte_array([1; 32])),
            value: Value::Explicit(1000),
            nonce: Nonce::Null,
            script_pubkey: Script::from(vec![0x51]),
            witness: TxOutWitness::default(),
        }],
    }
}

fn wire() -> serde_json::Value {
    let parent = parent();
    json!({"txid":parent.txid().to_string(),"vout":0,"transaction":elements::encode::serialize_hex(&parent),"spendable":true})
}

#[test]
fn input_decodes_once_and_round_trips_its_parent() {
    let input: Utxo = serde_json::from_value(wire()).unwrap();
    assert_eq!(input.txout(), &parent().output[0]);
    assert_eq!(input.ownership(), Ownership::Unlocated);
    assert_eq!(input.status(), InputStatus::Spendable);
    assert_eq!(serde_json::to_value(input).unwrap(), wire());
}

#[test]
fn serde_rejects_conflicting_sources_and_ownership() {
    let mut both = wire();
    both["txOut"] = json!(elements::encode::serialize_hex(&parent().output[0]));
    assert!(serde_json::from_value::<Utxo>(both).is_err());
    let mut neither = wire();
    neither.as_object_mut().unwrap().remove("transaction");
    assert!(serde_json::from_value::<Utxo>(neither).is_err());
    let mut owners = wire();
    owners["walletKey"] = json!({"branch":0,"index":0});
    owners["holderKey"] = json!({"derivationIndex":0,"ownerPublicKey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"});
    assert!(serde_json::from_value::<Utxo>(owners).is_err());
}

#[test]
fn parent_id_and_output_index_are_constructor_invariants() {
    let tx = parent();
    let id = ConsensusTxid::from(tx.txid().to_byte_array()).into();
    assert_eq!(
        Utxo::new(
            Outpoint::new(id, 1),
            InputSource::Parent(tx.clone()),
            Ownership::Unlocated,
            InputStatus::Spendable
        )
        .unwrap_err(),
        UtxoError::OutputIndex
    );
    assert_eq!(
        Utxo::new(
            Outpoint::new([0; 32].into(), 0),
            InputSource::Parent(tx),
            Ownership::Unlocated,
            InputStatus::Spendable
        )
        .unwrap_err(),
        UtxoError::ParentId
    );
    for (field, value) in [
        ("txid", json!("00".repeat(32))),
        ("vout", json!(1)),
        ("transaction", json!("invalid")),
    ] {
        let mut input = wire();
        input[field] = value;
        assert!(
            serde_json::from_value::<Utxo>(input).is_err(),
            "accepted {field}"
        );
    }
}
