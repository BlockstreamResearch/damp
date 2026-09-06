//! Ten-output native relation arithmetic cost probe. No host-context provenance claim.

use hl::{ast::ElementsJetHinter, parse::ParseFromStr, simplicity::BitMachine};
use simplex::simplicityhl::{self as hl, Arguments, CompiledProgram, Value, WitnessValues};
use std::collections::HashMap;
fn ge(raw: &str) -> String {
    let secp = hl::elements::secp256k1_zkp::PublicKey::from_slice(&hex::decode(raw).unwrap())
        .unwrap()
        .serialize_uncompressed();
    format!(
        "(0x{}, 0x{})",
        hex::encode(&secp[1..33]),
        hex::encode(&secp[33..])
    )
}
fn main() {
    let rows: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("docs/pgc-phase-zero/host-probe.json").unwrap(),
    )
    .unwrap();

    let mut source = String::from(
        r#"
fn check(c: Ge, h: Ge, p: Ge, d: Ge, tc: Ge, td: Ge, e: u256, zv: u256, zb: u256) {
    assert!(jet::ge_is_on_curve(c)); assert!(jet::ge_is_on_curve(h));
    assert!(jet::ge_is_on_curve(p)); assert!(jet::ge_is_on_curve(d));
    assert!(jet::ge_is_on_curve(tc)); assert!(jet::ge_is_on_curve(td));
    assert!(jet::eq_256(zv, jet::scalar_normalize(zv)));
    assert!(jet::eq_256(zb, jet::scalar_normalize(zb)));
    let left: Gej = jet::linear_combination_1((zv, (h, 1)), zb);
    let right: Gej = jet::gej_ge_add(jet::scale(e, (c, 1)), tc);
    assert!(jet::gej_equiv(left, right));
    let left: Gej = jet::scale(zb, (p, 1));
    let right: Gej = jet::gej_ge_add(jet::scale(e, (d, 1)), td);
    assert!(jet::gej_equiv(left, right));
}
fn main() {
"#,
    );
    let mut map = HashMap::new();
    for i in 0..10 {
        let r = &rows["vectors"][i];
        for field in ["c", "h", "key", "handle", "tc", "td"] {
            let name = format!("{}_{}", field.to_uppercase(), i);
            map.insert(
                hl::str::WitnessName::from_str_unchecked(&name),
                Value::parse_from_str(
                    &ge(r[field].as_str().unwrap()),
                    &hl::types::ResolvedType::parse_from_str("Ge").unwrap(),
                )
                .unwrap(),
            );
        }
        for field in ["challenge", "zv", "zb"] {
            let name = format!("{}_{}", field.to_uppercase(), i);
            let value = r[field].as_str().unwrap();
            let value = format!("0x{:0>64}", value.trim_start_matches("0x"));
            map.insert(
                hl::str::WitnessName::from_str_unchecked(&name),
                Value::parse_from_str(
                    &value,
                    &hl::types::ResolvedType::parse_from_str("u256").unwrap(),
                )
                .unwrap(),
            );
        }
        source.push_str(&format!("check(witness::C_{i}, witness::H_{i}, witness::KEY_{i}, witness::HANDLE_{i}, witness::TC_{i}, witness::TD_{i}, witness::CHALLENGE_{i}, witness::ZV_{i}, witness::ZB_{i});\n"));
    }
    source.push_str("}\n");
    let p = CompiledProgram::new(
        source,
        Arguments::default(),
        false,
        Box::new(ElementsJetHinter),
    )
    .unwrap();
    let witness: WitnessValues = map.clone().into();
    let s = p.satisfy(witness).unwrap();
    let node = s.redeem();
    let env = hl::dummy_env::dummy();
    assert!(
        BitMachine::for_program(node)
            .unwrap()
            .exec(node, &env)
            .is_ok()
    );
    map.insert(
        hl::str::WitnessName::from_str_unchecked("ZV_9"),
        Value::parse_from_str(
            "0",
            &hl::types::ResolvedType::parse_from_str("u256").unwrap(),
        )
        .unwrap(),
    );
    let bad = p.satisfy(map.into()).unwrap();
    assert!(
        BitMachine::for_program(bad.redeem())
            .unwrap()
            .exec(bad.redeem(), &env)
            .is_err()
    );
    let (program, witness) = node.to_vec_with_witness();
    let stack = vec![
        witness.clone(),
        program.clone(),
        node.cmr().as_ref().to_vec(),
        env.control_block().serialize(),
    ];
    println!(
        "{}",
        serde_json::json!({"scope":"ten native cross-base equations using libsecp-backed host vectors; arithmetic kernel ONLY: challenge/points supplied by witness, no transaction mapping or full covenant","outputs":10,"positive":true,"last_output_mutation_rejected":true,"execution_milliweight":node.bounds().cost.to_string(),"program_bytes":program.len(),"witness_data_bytes":witness.len(),"serialized_stack_bytes":hl::elements::encode::serialize(&stack).len(),"required_padding_bytes":node.bounds().cost.get_padding(&stack).map_or(0,|v|v.len())})
    );
}
