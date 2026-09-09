use simplicity_damp_core::{
    error::ParseError,
    ledger::{
        Amount, AssetId, AuditAmount, AuditPublicKey, ConsensusTxid, Outpoint, Txid, XOnlyKey,
    },
};

#[test]
fn amounts_parse_canonical_decimal_and_enforce_bounds() -> Result<(), ParseError> {
    for bad in [
        "",
        "0",
        "00",
        "01",
        "+1",
        "-1",
        "1.0",
        " 1",
        "1 ",
        "18446744073709551616",
    ] {
        assert_eq!(bad.parse::<Amount>(), Err(ParseError::Amount));
        assert!(serde_json::from_value::<Amount>(serde_json::json!(bad)).is_err());
    }
    assert_eq!("1".parse::<Amount>()?.get(), 1);
    assert_eq!(u64::MAX.to_string().parse::<Amount>()?.get(), u64::MAX);
    assert_eq!(
        i64::MAX.to_string().parse::<AuditAmount>()?.get(),
        i64::MAX as u64
    );
    assert!(AuditAmount::try_from(1u64 << 63).is_err());
    assert!(
        serde_json::from_value::<AuditAmount>(serde_json::json!((1u64 << 63).to_string())).is_err()
    );
    assert!(serde_json::from_value::<Amount>(serde_json::json!(1)).is_err());
    Ok(())
}

#[test]
fn identifiers_keep_display_and_consensus_order_distinct() -> Result<(), Box<dyn std::error::Error>>
{
    let display = format!("01{}", "00".repeat(31));
    let txid: Txid = display.parse()?;
    let consensus = ConsensusTxid::from(txid);
    assert_eq!(consensus.to_byte_array()[31], 1);
    assert_eq!(Txid::from(consensus), txid);
    let outpoint: Outpoint = format!("{display}:7").parse()?;
    assert_eq!(outpoint.txid(), txid);
    assert_eq!(outpoint.vout(), 7);
    assert_eq!(
        serde_json::to_value(outpoint)?,
        serde_json::json!(format!("{display}:7"))
    );
    for suffix in ["-1", "+1", "01", "4294967296", "1:2"] {
        assert!(format!("{display}:{suffix}").parse::<Outpoint>().is_err());
    }
    assert!("A0".repeat(32).parse::<AssetId>().is_err());
    assert!(serde_json::from_value::<AssetId>(serde_json::json!(vec![0; 32])).is_err());
    Ok(())
}

#[test]
fn public_key_deserialization_cannot_bypass_curve_checks() {
    for invalid in ["00".repeat(32), "ff".repeat(32)] {
        assert!(invalid.parse::<XOnlyKey>().is_err());
        assert!(serde_json::from_value::<XOnlyKey>(serde_json::json!(invalid)).is_err());
    }
    assert!(serde_json::from_value::<AuditPublicKey>(serde_json::json!("00".repeat(33))).is_err());
}
