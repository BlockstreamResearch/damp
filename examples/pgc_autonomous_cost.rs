//! Actual introspection + Fiat-Shamir + native QR relation, ten-output research probe.
use hl::{
    ast::ElementsJetHinter,
    elements::{
        self, confidential,
        hashes::{Hash, sha256},
        secp256k1_zkp::{PedersenCommitment, PublicKey},
    },
    parse::ParseFromStr,
    simplicity::{
        BitMachine,
        jet::elements::{ElementsEnv, ElementsUtxo},
    },
};
use simplex::simplicityhl::{self as hl, Arguments, CompiledProgram, Value, WitnessValues};
use std::{
    collections::HashMap,
    io::Write,
    process::{Command, Stdio},
    sync::Arc,
};
pub(crate) fn source(key: &str, asset: &str) -> String {
    let key = hex::decode(key).unwrap();
    let tag = sha256::Hash::hash(b"DAMP/audit/autonomous/v2").to_string();
    let mut s = format!(
        r#"
fn point_ge(p: Point) -> Ge {{
    let (bit,x): Point = p;
    assert!(jet::eq_256(x,jet::fe_normalize(x)));
    unwrap(jet::decompress((bit,x)))
}}
fn hash_point(ctx: Ctx8,p: Point)->Ctx8{{
    let (bit,x):Point=p;
    let prefix:u8=match <u1>::into(bit) {{false=>2,true=>3,}};
    let ctx:Ctx8=jet::sha_256_ctx_8_add_1(ctx,prefix);
    jet::sha_256_ctx_8_add_32(ctx,x)
}}
fn check(index:u32, parity:u1, root:u256,d:Point,tc:Point,td:Point,zv:u256,zb:u256){{
    let (asset,amount):(Asset1,Amount1)=unwrap(jet::output_amount(index));
    let asset:u256=unwrap_right::<Point>(asset);
    assert!(jet::eq_256(asset,0x{asset}));
    let (qr,x):Point=unwrap_left::<u64>(amount);
    let c:Ge=point_ge((parity,x));
    let (_x,y):Ge=c;
    assert!(jet::eq_256(root,jet::fe_normalize(root)));
    let expected:u256=match <u1>::into(qr) {{false=>y,true=>jet::fe_negate(y),}};
    assert!(jet::eq_256(jet::fe_square(root),expected));
    let h:Ge=jet::hash_to_curve(asset);
    let p_point:Point=(0b{kp},0x{kx});
    let p:Ge=point_ge(p_point);
    let dg:Ge=point_ge(d);let tcg:Ge=point_ge(tc);let tdg:Ge=point_ge(td);
    assert!(jet::eq_256(zv,jet::scalar_normalize(zv)));
    assert!(jet::eq_256(zb,jet::scalar_normalize(zb)));
    let ctx:Ctx8=jet::sha_256_ctx_8_init();
    let ctx:Ctx8=jet::sha_256_ctx_8_add_32(ctx,0x{tag});
    let ctx:Ctx8=jet::sha_256_ctx_8_add_32(ctx,0x{tag});
    let ctx:Ctx8=jet::sha_256_ctx_8_add_32(ctx,0x{deployment});
    let ctx:Ctx8=jet::sha_256_ctx_8_add_4(ctx,2);
    let ctx:Ctx8=jet::sha_256_ctx_8_add_8(ctx,1);
    let ctx:Ctx8=hash_point(ctx,p_point);
    let ctx:Ctx8=jet::sha_256_ctx_8_add_32(ctx,jet::sig_all_hash());
    let ctx:Ctx8=jet::sha_256_ctx_8_add_4(ctx,index);
    let ctx:Ctx8=jet::sha_256_ctx_8_add_32(ctx,asset);
    let prefix:u8=match <u1>::into(qr) {{false=>8,true=>9,}};
    let ctx:Ctx8=jet::sha_256_ctx_8_add_1(ctx,prefix);
    let ctx:Ctx8=jet::sha_256_ctx_8_add_32(ctx,x);
    let ctx:Ctx8=jet::sha_256_ctx_8_add_32(ctx,unwrap(jet::output_script_hash(index)));
    let ctx:Ctx8=jet::sha_256_ctx_8_add_1(ctx,0);
    let ctx:Ctx8=hash_point(ctx,d);let ctx:Ctx8=hash_point(ctx,tc);let ctx:Ctx8=hash_point(ctx,td);
    let e:u256=jet::scalar_normalize(jet::sha_256_ctx_8_finalize(ctx));
    assert!(jet::gej_equiv(jet::linear_combination_1((zv,(h,1)),zb),jet::gej_ge_add(jet::scale(e,(c,1)),tcg)));
    assert!(jet::gej_equiv(jet::scale(zb,(p,1)),jet::gej_ge_add(jet::scale(e,(dg,1)),tdg)));
}}
fn main(){{
    assert!(jet::eq_32(jet::current_index(),0));
    assert!(jet::eq_32(jet::num_outputs(),12));
"#,
        kp = key[0] & 1,
        kx = hex::encode(&key[1..]),
        deployment = hex::encode([42; 32])
    );
    for i in 0..10 {
        s.push_str(&format!("check({},witness::C_PARITY_{i},witness::C_ROOT_{i},witness::D_{i},witness::TC_{i},witness::TD_{i},witness::ZV_{i},witness::ZB_{i});\n",i+1));
    }
    s.push_str("}\n");
    s
}
fn environment(
    tx: elements::Transaction,
    cmr: hl::simplicity::Cmr,
) -> ElementsEnv<Arc<elements::Transaction>> {
    let dummy = hl::dummy_env::dummy();
    ElementsEnv::new(
        Arc::new(tx.clone()),
        vec![
            ElementsUtxo {
                script_pubkey: elements::Script::new(),
                asset: confidential::Asset::Explicit(elements::AssetId::from_byte_array([17; 32])),
                value: confidential::Value::Explicit(1)
            };
            tx.input.len()
        ],
        0,
        cmr,
        dummy.control_block().clone(),
        None,
        elements::BlockHash::all_zeros(),
    )
}
pub(crate) fn prove(
    request: &serde_json::Value,
) -> anyhow::Result<HashMap<hl::str::WitnessName, Value>> {
    let mut child = Command::new("python3")
        .arg("scripts/pgc-autonomous-prover.py")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&request)?.as_bytes())?;
    let output = child.wait_with_output()?;
    anyhow::ensure!(output.status.success(), "research prover failed");
    let values: HashMap<String, String> = serde_json::from_slice(&output.stdout)?;
    let mut map = HashMap::new();
    for (name, value) in values {
        let ty = if name.starts_with("C_PARITY") {
            "u1"
        } else if name.starts_with("C_ROOT") || name.starts_with('Z') {
            "u256"
        } else {
            "Point"
        };
        map.insert(
            hl::str::WitnessName::from_str_unchecked(&name),
            Value::parse_from_str(
                &value,
                &hl::types::ResolvedType::parse_from_str(ty).unwrap(),
            )
            .unwrap(),
        );
    }
    Ok(map)
}
fn main() -> anyhow::Result<()> {
    let native: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        "docs/pgc-phase-zero/native-vectors.json",
    )?)?;
    let host: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        "docs/pgc-phase-zero/host-probe.json",
    )?)?;
    let key = host["vectors"][0]["key"].as_str().unwrap();
    PublicKey::from_slice(&hex::decode(key)?)?;
    let p = CompiledProgram::new(
        source(key, native["asset"].as_str().unwrap()),
        Arguments::default(),
        false,
        Box::new(ElementsJetHinter),
    )
    .map_err(anyhow::Error::msg)?;
    let mut tx = hl::dummy_env::dummy().tx().clone();
    tx.input = vec![tx.input[0].clone(); 12];
    for (i, input) in tx.input.iter_mut().enumerate() {
        input.previous_output.vout = i as u32;
    }
    tx.output = vec![
        elements::TxOut {
            asset: confidential::Asset::Explicit(elements::AssetId::from_byte_array([17; 32])),
            value: confidential::Value::Explicit(1),
            ..Default::default()
        };
        12
    ];
    let mut outputs = Vec::new();
    for i in 0..10 {
        let row = &native["vectors"][i];
        tx.output[i + 1].value = confidential::Value::Confidential(PedersenCommitment::from_slice(
            &hex::decode(row["commitment"].as_str().unwrap())?,
        )?);
        tx.output[i + 1].script_pubkey = elements::Script::from(vec![0x51, i as u8]);
        let mut row = row.clone();
        row["script_hash"] = sha256::Hash::hash(tx.output[i + 1].script_pubkey.as_bytes())
            .to_string()
            .into();
        outputs.push(row);
    }
    let env = environment(tx.clone(), p.commit().cmr());
    let request = serde_json::json!({"key":key,"generator":native["generator"],"asset":native["asset"],"deployment":hex::encode([42;32]),"epoch":1,"sig_all_hash":hex::encode(env.c_tx_env().sighash_all().to_byte_array()),"outputs":outputs});
    let map = prove(&request)?;
    let witness: WitnessValues = map.clone().into();
    let satisfied = p.satisfy(witness).map_err(anyhow::Error::msg)?;
    let node = satisfied.redeem();
    BitMachine::for_program(node)?.exec(node, &env)?;
    let mut controls = Vec::new();
    for field in ["C_PARITY_9", "C_ROOT_9", "D_9", "ZV_9", "ZB_9"] {
        let mut bad = map.clone();
        let name = hl::str::WitnessName::from_str_unchecked(field);
        let value = if field.starts_with("C_PARITY") {
            {
                let zero = Value::parse_from_str(
                    "0b0",
                    &hl::types::ResolvedType::parse_from_str("u1").unwrap(),
                )
                .unwrap();
                if bad[&name] == zero {
                    Value::parse_from_str(
                        "0b1",
                        &hl::types::ResolvedType::parse_from_str("u1").unwrap(),
                    )
                    .unwrap()
                } else {
                    zero
                }
            }
        } else if field.starts_with('D') {
            map[&hl::str::WitnessName::from_str_unchecked("D_8")].clone()
        } else {
            Value::parse_from_str(
                "0",
                &hl::types::ResolvedType::parse_from_str("u256").unwrap(),
            )
            .unwrap()
        };
        if bad[&name] == value {
            continue;
        }
        bad.insert(name, value);
        let bad = p.satisfy(bad.into()).map_err(anyhow::Error::msg)?;
        assert!(
            BitMachine::for_program(bad.redeem())?
                .exec(bad.redeem(), &env)
                .is_err(),
            "{field}"
        );
        controls.push(field);
    }
    for (field, ty, value) in [
        (
            "ZV_9",
            "u256",
            "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
        ),
        (
            "C_ROOT_9",
            "u256",
            "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f",
        ),
        (
            "D_9",
            "Point",
            "(0b0,0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f)",
        ),
        (
            "TC_9",
            "Point",
            "(0b0,0x0000000000000000000000000000000000000000000000000000000000000000)",
        ),
    ] {
        let mut bad = map.clone();
        bad.insert(
            hl::str::WitnessName::from_str_unchecked(field),
            Value::parse_from_str(value, &hl::types::ResolvedType::parse_from_str(ty).unwrap())
                .unwrap(),
        );
        let bad = p.satisfy(bad.into()).map_err(anyhow::Error::msg)?;
        assert!(
            BitMachine::for_program(bad.redeem())?
                .exec(bad.redeem(), &env)
                .is_err(),
            "canonical {field}"
        );
    }
    controls.push("noncanonical_scalar_and_field_and_invalid_point");
    for case in [
        "output_script",
        "output_commitment",
        "output_asset",
        "input_outpoint",
        "input_sequence",
        "locktime",
        "output_order",
    ] {
        let mut changed = tx.clone();
        match case {
            "output_script" => {
                changed.output[10].script_pubkey = elements::Script::from(vec![0x52])
            }
            "output_commitment" => changed.output[10].value = changed.output[9].value,
            "output_asset" => {
                changed.output[10].asset =
                    confidential::Asset::Explicit(elements::AssetId::from_byte_array([18; 32]))
            }
            "input_outpoint" => changed.input[5].previous_output.vout += 1,
            "input_sequence" => changed.input[5].sequence = elements::Sequence(7),
            "locktime" => changed.lock_time = elements::LockTime::from_consensus(7),
            _ => changed.output.swap(9, 10),
        }
        assert!(
            BitMachine::for_program(node)?
                .exec(node, &environment(changed, p.commit().cmr()))
                .is_err(),
            "{case}"
        );
        controls.push(case);
    }
    let (program, witness) = node.to_vec_with_witness();
    let stack = vec![
        witness.clone(),
        program.clone(),
        node.cmr().as_ref().to_vec(),
        env.control_block().serialize(),
    ];
    println!(
        "{}",
        serde_json::json!({"scope":"autonomous native proof with real output introspection, QR reconstruction, asset-derived generator and Fiat-Shamir; ten outputs; synthetic environment, full DAMP/consensus not yet integrated","positive":true,"negative_controls":controls,"execution_milliweight":node.bounds().cost.to_string(),"serialized_stack_bytes":elements::encode::serialize(&stack).len(),"program_bytes":program.len(),"witness_data_bytes":witness.len(),"required_padding_bytes":node.bounds().cost.get_padding(&stack).map_or(0,|p|p.len()),"cmr":node.cmr().to_string()})
    );
    Ok(())
}
