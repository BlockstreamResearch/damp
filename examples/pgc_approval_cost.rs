//! Executable issuer-admission research gate, not a complete DAMP covenant.
#[path = "support/admission.rs"]
mod admission;
use hl::ast::ElementsJetHinter;
use hl::elements::{
    self, confidential,
    hashes::{Hash, sha256},
    secp256k1_zkp::{Keypair, Message, Secp256k1, SecretKey},
};
use hl::simplicity::jet::elements::{ElementsEnv, ElementsUtxo};
use hl::simplicity::{BitMachine, Cmr};
use simplex::simplicityhl::parse::ParseFromStr;
use simplex::simplicityhl::{self as hl, Arguments, CompiledProgram, Value, WitnessValues};
use std::{collections::HashMap, sync::Arc};

pub(crate) fn source(key: &str, deployment: &str, epoch: u64) -> String {
    let mut records = String::new();
    for i in 0..10 {
        records.push_str(&format!("let (prefix, x): (u8, u256) = witness::HANDLE_{i};\n let ctx: Ctx8 = jet::sha_256_ctx_8_add_1(ctx, prefix);\n let ctx: Ctx8 = jet::sha_256_ctx_8_add_32(ctx, x);\n"));
    }
    format!(
        r#"fn main() {{
        assert!(jet::eq_32(jet::current_index(), 0));
        let ctx: Ctx8 = jet::sha_256_ctx_8_init();
        let ctx: Ctx8 = jet::sha_256_ctx_8_add_32(ctx, 0x{tag});
        let ctx: Ctx8 = jet::sha_256_ctx_8_add_32(ctx, 0x{deployment});
        let ctx: Ctx8 = jet::sha_256_ctx_8_add_4(ctx, 2);
        let ctx: Ctx8 = jet::sha_256_ctx_8_add_8(ctx, {epoch});
        let ctx: Ctx8 = jet::sha_256_ctx_8_add_32(ctx, jet::sig_all_hash());
        {records}
        jet::bip_0340_verify((0x{key}, jet::sha_256_ctx_8_finalize(ctx)), witness::APPROVAL);
    }}"#,
        tag = sha256::Hash::hash(b"DAMP/issuer-approval/v2")
    )
}
fn compile(s: String) -> CompiledProgram {
    CompiledProgram::new(s, Arguments::default(), false, Box::new(ElementsJetHinter)).unwrap()
}
fn env(
    tx: elements::Transaction,
    cmr: Cmr,
    genesis: u8,
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
        elements::BlockHash::from_byte_array([genesis; 32]),
    )
}
pub(crate) fn digest(
    e: &ElementsEnv<Arc<elements::Transaction>>,
    deployment: [u8; 32],
    epoch: u64,
) -> [u8; 32] {
    let mut bytes = sha256::Hash::hash(b"DAMP/issuer-approval/v2")
        .to_byte_array()
        .to_vec();
    bytes.extend(deployment);
    bytes.extend(2u32.to_be_bytes());
    bytes.extend(epoch.to_be_bytes());
    bytes.extend(e.c_tx_env().sighash_all().to_byte_array());
    for i in 0..10 {
        bytes.extend(handle(i));
    }
    sha256::Hash::hash(&bytes).to_byte_array()
}
fn handle(i: usize) -> Vec<u8> {
    let raw: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("docs/pgc-phase-zero/host-probe.json").unwrap(),
    )
    .unwrap();
    hex::decode(raw["vectors"][i]["handle"].as_str().unwrap()).unwrap()
}
pub(crate) fn witness(sig: &[u8]) -> WitnessValues {
    let ty = hl::types::ResolvedType::parse_from_str("Signature").unwrap();
    let mut map = HashMap::from([(
        hl::str::WitnessName::from_str_unchecked("APPROVAL"),
        Value::parse_from_str(&format!("0x{}", hex::encode(sig)), &ty).unwrap(),
    )]);
    for i in 0..10 {
        let bytes = handle(i);
        map.insert(
            hl::str::WitnessName::from_str_unchecked(&format!("HANDLE_{i}")),
            Value::parse_from_str(
                &format!("({}, 0x{})", bytes[0], hex::encode(&bytes[1..])),
                &hl::types::ResolvedType::parse_from_str("(u8,u256)").unwrap(),
            )
            .unwrap(),
        );
    }
    map.into()
}
fn run(p: &CompiledProgram, e: &ElementsEnv<Arc<elements::Transaction>>, w: WitnessValues) -> bool {
    let s = p.satisfy(w).unwrap();
    BitMachine::for_program(s.redeem())
        .unwrap()
        .exec(s.redeem(), e)
        .is_ok()
}
fn main() {
    let secp = Secp256k1::new();
    let sk = SecretKey::from_slice(&[3; 32]).unwrap();
    let key = Keypair::from_secret_key(&secp, &sk);
    let deployment = [42; 32];
    let epoch = 1;
    let p = compile(source(
        &key.x_only_public_key().0.to_string(),
        &hex::encode(deployment),
        epoch,
    ));
    let mut tx = hl::dummy_env::dummy().tx().clone();
    tx.output = vec![
        elements::TxOut {
            asset: confidential::Asset::Explicit(elements::AssetId::from_byte_array([17; 32])),
            value: confidential::Value::Explicit(1),
            ..Default::default()
        };
        12
    ];
    tx.output[0].asset =
        confidential::Asset::Explicit(elements::AssetId::from_byte_array([18; 32]));
    tx.output[11].asset =
        confidential::Asset::Explicit(elements::AssetId::from_byte_array([19; 32]));
    let vectors: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("docs/pgc-phase-zero/native-vectors.json").unwrap(),
    )
    .unwrap();
    for i in 0..10 {
        tx.output[i + 1].value = confidential::Value::Confidential(
            hl::elements::secp256k1_zkp::PedersenCommitment::from_slice(
                &hex::decode(vectors["vectors"][i]["commitment"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
        );
    }
    tx.input = vec![tx.input[0].clone(); 12];
    for (i, input) in tx.input.iter_mut().enumerate() {
        input.previous_output.vout = i as u32;
    }
    let host: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("docs/pgc-phase-zero/host-probe.json").unwrap(),
    )
    .unwrap();
    let audit_key = hl::elements::secp256k1_zkp::PublicKey::from_slice(
        &hex::decode(host["vectors"][0]["key"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    let openings: Vec<_> = (0..10)
        .map(|i| admission::Opening {
            index: i as u32 + 1,
            value: vectors["vectors"][i]["value"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            blinder: hex::decode(vectors["vectors"][i]["blinder"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
            handle: handle(i).try_into().unwrap(),
        })
        .collect();
    let asset = elements::AssetId::from_byte_array([17; 32]);
    let start = std::time::Instant::now();
    admission::validate(&tx, asset, audit_key, &openings).unwrap();
    let opening_validation_micros = start.elapsed().as_micros();
    assert!(admission::validate(&tx, asset, audit_key, &openings[..9]).is_err());
    let mut bad_openings = openings.clone();
    bad_openings[0].value = 2;
    assert!(admission::validate(&tx, asset, audit_key, &bad_openings).is_err());
    let mut bad_openings = openings.clone();
    bad_openings.swap(0, 1);
    assert!(admission::validate(&tx, asset, audit_key, &bad_openings).is_err());
    let mut bad_openings = openings.clone();
    bad_openings[0].handle = bad_openings[1].handle;
    assert!(admission::validate(&tx, asset, audit_key, &bad_openings).is_err());
    let e = env(tx.clone(), p.commit().cmr(), 0);
    let sig =
        secp.sign_schnorr_no_aux_rand(&Message::from_digest(digest(&e, deployment, epoch)), &key);
    assert!(run(&p, &e, witness(sig.as_ref())));
    assert!(p.satisfy(WitnessValues::default()).is_err());
    assert!(!run(&p, &e, witness(&[0; 64])));
    let mut changed_handles: HashMap<_, _> = witness(sig.as_ref())
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    changed_handles.insert(
        hl::str::WitnessName::from_str_unchecked("HANDLE_9"),
        Value::parse_from_str(
            "(2, 0)",
            &hl::types::ResolvedType::parse_from_str("(u8,u256)").unwrap(),
        )
        .unwrap(),
    );
    assert!(!run(&p, &e, changed_handles.into()));
    let mut controls = vec!["audit_handle"];

    for case in [
        "amount",
        "asset",
        "script",
        "outpoint",
        "sequence",
        "locktime",
        "version",
        "output_count",
        "input_count",
        "genesis",
    ] {
        let mut changed = tx.clone();
        match case {
            "amount" => changed.output[1].value = confidential::Value::Explicit(2),
            "asset" => {
                changed.output[1].asset =
                    confidential::Asset::Explicit(elements::AssetId::from_byte_array([18; 32]))
            }
            "script" => changed.output[1].script_pubkey = elements::Script::from(vec![0x51]),
            "outpoint" => changed.input[0].previous_output.vout = 99,
            "sequence" => changed.input[1].sequence = elements::Sequence(1),
            "locktime" => changed.lock_time = elements::LockTime::from_height(1).unwrap(),
            "version" => changed.version = 3,
            "output_count" => {
                changed.output.pop();
            }
            "input_count" => {
                changed.input.pop();
            }
            _ => {}
        }
        assert!(
            !run(
                &p,
                &env(changed, p.commit().cmr(), u8::from(case == "genesis")),
                witness(sig.as_ref())
            ),
            "{case}"
        );
        controls.push(case);
    }
    for (label, dep, ep) in [("deployment", [43; 32], 1), ("epoch", deployment, 2)] {
        let changed = compile(source(
            &key.x_only_public_key().0.to_string(),
            &hex::encode(dep),
            ep,
        ));
        assert!(!run(
            &changed,
            &env(tx.clone(), changed.commit().cmr(), 0),
            witness(sig.as_ref())
        ));
        controls.push(label);
    }
    let s = p.satisfy(witness(sig.as_ref())).unwrap();
    let node = s.redeem();
    let (program, proof) = node.to_vec_with_witness();
    let stack = vec![
        proof.clone(),
        program.clone(),
        node.cmr().as_ref().to_vec(),
        e.control_block().serialize(),
    ];
    println!(
        "{}",
        serde_json::json!({"scope":"issuer approval kernel only; 12 inputs/12 outputs with ten distinct native commitments; synthetic environment; no native consensus or full policy claim","positive":true,"opening_validation_micros":opening_validation_micros,"invalid_missing_reordered_openings_rejected":true,"mutation_controls":controls,"missing_signature_rejected":true,"execution_milliweight":node.bounds().cost.to_string(),"program_bytes":program.len(),"witness_data_bytes":proof.len(),"serialized_stack_bytes":elements::encode::serialize(&stack).len(),"required_padding_bytes":node.bounds().cost.get_padding(&stack).map_or(0,|p|p.len()),"cmr":node.cmr().to_string()})
    );
}
