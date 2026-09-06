//! Maximum-shape anchor prototype: current D6 policy + native amounts + autonomous native proof.
//! Research only. Does not mutate shipped generation-1 artifacts.
#[allow(dead_code)]
#[path = "pgc_autonomous_linear_cost.rs"]
mod autonomous;
use hl::{
    ast::ElementsJetHinter,
    elements::{
        self, confidential,
        hashes::Hash,
        pset::{Input, Output, PartiallySignedTransaction},
        secp256k1_zkp::{Keypair, PedersenCommitment, Secp256k1, SecretKey},
    },
    simplicity::{
        BitMachine,
        jet::elements::{ElementsEnv, ElementsUtxo},
    },
};
use simplex::{
    program::ArgumentsTrait,
    provider::SimplicityNetwork,
    simplicityhl::{self as hl, CompiledProgram, UnstableFeatures, WitnessValues},
};
use simplicity_amp::{
    artifacts::verifier_d6::{VerifierD6Program, derived_verifier_d6::VerifierD6Arguments},
    policy::{IndexedInputPolicyProof, PolicySet, TreeDepth, outpoint_key},
    protocol::{Protocol, ProtocolConfig},
};
use std::{collections::HashMap, sync::Arc};
fn main() -> anyhow::Result<()> {
    let secp = Secp256k1::new();
    let key = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[3; 32])?);
    let owner = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[4; 32])?)
        .x_only_public_key()
        .0;
    let network = SimplicityNetwork::default_regtest();
    let asset = elements::AssetId::from_byte_array([17; 32]);
    let anchor_asset = elements::AssetId::from_byte_array([18; 32]);
    let protocol = Protocol::new(ProtocolConfig {
        regulated_asset: asset,
        verifier_asset: anchor_asset,
        verifier_asset_amount: 1,
        issuer: key.x_only_public_key().0,
        network,
    })?;
    let policy = PolicySet::new(TreeDepth::D6, [[0; 32], [255; 32]])?;
    let commitment = policy.commitment();
    let args = VerifierD6Arguments {
        blacklist_count: commitment.count,
        blacklist_root: commitment.root,
        regulated_asset_id: asset.into_inner().0,
        user_executable_leaf_hash: protocol.user_executable_leaf_hash(),
        verifier_asset_amount: 1,
        verifier_asset_id: anchor_asset.into_inner().0,
    };
    let mut source = VerifierD6Program::SOURCE.to_owned();
    let old = "(unwrap_right::<(u1, u256)>(asset), unwrap_right::<(u1, u256)>(amount))";
    assert_eq!(source.matches(old).count(), 2);
    source=source.replace(old,"(unwrap_right::<(u1, u256)>(asset), match amount { Left(_c: (u1,u256)) => { assert!(jet::eq_256(unwrap_right::<(u1,u256)>(asset), param::REGULATED_ASSET_ID)); 1 }, Right(v: u64) => v, })");
    // Sentinel amounts preserve existing count/owner/policy scanning only; consensus
    // must validate true native conservation, never these sentinels.
    assert_eq!(
        source
            .matches("assert_eq_64(regulated_output_amount, regulated_input_amount);")
            .count(),
        1
    );
    source = source.replace(
        "assert_eq_64(regulated_output_amount, regulated_input_amount);",
        "();",
    );
    let native: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        "docs/pgc-phase-zero/native-vectors.json",
    )?)?;
    let host: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        "docs/pgc-phase-zero/host-probe.json",
    )?)?;
    let audit_key = host["vectors"][0]["key"].as_str().unwrap();
    let audit = autonomous::source(audit_key, native["asset"].as_str().unwrap());
    let (helpers, body) = audit.split_once("fn main(){").unwrap();
    let body = body.strip_suffix("}\n").unwrap();
    source = source.replacen(
        "    fn main() {",
        &format!("{helpers}\n    fn main() {{"),
        1,
    );
    source = source.replacen("fn main() {", &format!("fn main() {{\n{body}\n"), 1);
    // Exact maximum shape for this probe; reject issuance on every input.
    let mut shape = String::from(
        "assert!(jet::eq_32(jet::num_inputs(),12)); assert!(jet::eq_32(jet::num_outputs(),12));\n",
    );
    for i in 0..12 {
        shape.push_str(&format!("assert!(match unwrap(jet::issuance({i})) {{ None => true, Some(_issued: bool) => false, }});\n"));
    }
    source = source.replacen("fn main() {", &format!("fn main() {{\n{shape}"), 1);
    let compiled = CompiledProgram::new_with_unstable(
        source,
        &UnstableFeatures::all(),
        args.build_arguments(),
        false,
        Box::new(ElementsJetHinter),
    )
    .map_err(anyhow::Error::msg)?;
    let mut pst = PartiallySignedTransaction::new_v2();
    let mut spent = Vec::new();
    let mut proofs = Vec::new();
    let anchor_script = elements::Script::from(vec![0x51]); // environment fixture, not a published deployment
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        "docs/pgc-phase-zero/native-vectors.json",
    )?)?;
    for i in 0..12 {
        let outpoint =
            elements::OutPoint::new(elements::Txid::from_byte_array([i as u8 + 1; 32]), i as u32);
        let out = if i == 0 {
            elements::TxOut {
                asset: confidential::Asset::Explicit(anchor_asset),
                value: confidential::Value::Explicit(1),
                script_pubkey: anchor_script.clone(),
                ..Default::default()
            }
        } else if i == 11 {
            elements::TxOut {
                asset: confidential::Asset::Explicit(network.policy_asset()),
                value: confidential::Value::Explicit(25000),
                ..Default::default()
            }
        } else {
            proofs.push(IndexedInputPolicyProof::new(
                i as u32,
                policy.non_membership_proof(outpoint_key(outpoint))?,
            ));
            elements::TxOut {
                asset: confidential::Asset::Explicit(asset),
                value: confidential::Value::Confidential(PedersenCommitment::from_slice(
                    &hex::decode(raw["vectors"][i - 1]["commitment"].as_str().unwrap())?,
                )?),
                script_pubkey: protocol.user_script(owner),
                ..Default::default()
            }
        };
        let mut input = Input::from_prevout(outpoint);
        input.witness_utxo = Some(out.clone());
        input.asset = out.asset.explicit();
        input.amount = out.value.explicit();
        pst.add_input(input);
        let mut output = Output::new_explicit(
            out.script_pubkey.clone(),
            1,
            out.asset.explicit().unwrap(),
            None,
        );
        output.amount = out.value.explicit();
        output.amount_comm = out.value.commitment();
        pst.add_output(output);
        spent.push(out);
    }
    let tx = pst.extract_tx()?;
    let dummy = hl::dummy_env::dummy();
    let environment = ElementsEnv::new(
        Arc::new(tx.clone()),
        spent
            .iter()
            .map(|o| ElementsUtxo {
                asset: o.asset,
                value: o.value,
                script_pubkey: o.script_pubkey.clone(),
            })
            .collect(),
        0,
        compiled.commit().cmr(),
        dummy.control_block().clone(),
        None,
        elements::BlockHash::all_zeros(),
    );
    let mut outputs = Vec::new();
    for i in 0..10 {
        let mut row = native["vectors"][i].clone();
        row["script_hash"] =
            elements::hashes::sha256::Hash::hash(tx.output[i + 1].script_pubkey.as_bytes())
                .to_string()
                .into();
        outputs.push(row);
    }
    let request = serde_json::json!({"key":audit_key,"generator":native["generator"],"asset":native["asset"],"deployment":hex::encode([42;32]),"epoch":1,"sig_all_hash":hex::encode(environment.c_tx_env().sighash_all().to_byte_array()),"outputs":outputs});
    let w = Protocol::transfer_witness(commitment, owner, [Some(owner); 10], &proofs)?;
    let mut map: HashMap<_, _> = w.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    map.extend(autonomous::prove(&request)?);
    let base_map = map.clone();
    let witness: WitnessValues = map.into();
    let satisfied = compiled.satisfy(witness).map_err(anyhow::Error::msg)?;
    let node = satisfied.redeem().prune(&environment)?;
    BitMachine::for_program(&node)?.exec(&node, &environment)?;
    let mut fresh_proof_controls = Vec::new();
    for case in [
        "confidential_asset",
        "issuance",
        "wrong_recipient_script",
        "extra_output",
    ] {
        let mut altered = tx.clone();
        match case {
            "confidential_asset" => {
                altered.output[5].asset = confidential::Asset::Confidential(
                    hl::elements::secp256k1_zkp::Generator::new_unblinded(&secp, asset.into_tag()),
                )
            }
            "issuance" => altered.input[5].asset_issuance.amount = confidential::Value::Explicit(1),
            "wrong_recipient_script" => {
                altered.output[5].script_pubkey = elements::Script::from(vec![0x51])
            }
            _ => altered.output.push(altered.output[11].clone()),
        }
        let altered_env = ElementsEnv::new(
            Arc::new(altered),
            spent
                .iter()
                .map(|o| ElementsUtxo {
                    asset: o.asset,
                    value: o.value,
                    script_pubkey: o.script_pubkey.clone(),
                })
                .collect(),
            0,
            compiled.commit().cmr(),
            dummy.control_block().clone(),
            None,
            elements::BlockHash::all_zeros(),
        );
        // Regenerate the native proof against this exact malformed transaction.
        // Rejection must come from covenant policy, not stale Fiat-Shamir binding.
        let mut altered_request = request.clone();
        altered_request["sig_all_hash"] =
            hex::encode(altered_env.c_tx_env().sighash_all().to_byte_array()).into();
        for i in 0..10 {
            altered_request["outputs"][i]["script_hash"] = elements::hashes::sha256::Hash::hash(
                altered_env.tx().output[i + 1].script_pubkey.as_bytes(),
            )
            .to_string()
            .into();
        }
        let mut altered_map = base_map.clone();
        altered_map.extend(autonomous::prove(&altered_request)?);
        let altered_program = compiled
            .satisfy(altered_map.into())
            .map_err(anyhow::Error::msg)?;
        assert!(
            BitMachine::for_program(altered_program.redeem())?
                .exec(altered_program.redeem(), &altered_env)
                .is_err(),
            "{case}"
        );
        fresh_proof_controls.push(case);
    }
    let (program, w) = node.to_vec_with_witness();
    let stack = vec![
        w.clone(),
        program.clone(),
        node.cmr().as_ref().to_vec(),
        environment.control_block().serialize(),
    ];
    println!(
        "{}",
        serde_json::json!({"scope":"D6 anchor policy + native-value scan + four-linear-verify autonomous native QR and Fiat-Shamir audit executed at fixed 10 regulated inputs/outputs; artificial taproot/UTXO fixture, holder/native consensus/auxiliary recovery not integrated","positive":true,"fresh_proof_covenant_rejections":fresh_proof_controls,"execution_milliweight":node.bounds().cost.to_string(),"serialized_stack_bytes":elements::encode::serialize(&stack).len(),"program_bytes":program.len(),"witness_data_bytes":w.len(),"required_padding_bytes":node.bounds().cost.get_padding(&stack).map_or(0,|v|v.len())})
    );
    Ok(())
}
