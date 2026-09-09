//! Native confidential public audit records and their transaction-authenticated envelope manifest.
use crate::covenant::program::{AnchorBranch, CompiledAnchor, Protocol};
use anyhow::Context;
use damp_core::native_audit::{
    AUXILIARY_BYTES, AuditOpening, AuditOutput, AuditStatement, NativeAuditProof,
};
use elements::{
    hashes::{Hash, sha256},
    pset::PartiallySignedTransaction,
};
use simplicityhl::{
    ResolvedType, Value, WitnessValues,
    num::U256,
    str::WitnessName,
    types::TypeConstructible,
    value::{UIntValue, ValueConstructible},
};
use std::collections::HashMap;

fn word(bytes: [u8; 32]) -> Value {
    Value::from(UIntValue::U256(U256::from_byte_array(bytes)))
}
fn point(key: elements::secp256k1_zkp::PublicKey) -> Value {
    let b = key.serialize();
    Value::tuple([
        Value::from(UIntValue::U1(b[0] & 1)),
        word(b[1..].try_into().expect("public key x")),
    ])
}

pub fn transfer_witness(
    pset: &mut PartiallySignedTransaction,
    protocol: &Protocol,
    anchor: &CompiledAnchor,
    base: WitnessValues,
    openings: &crate::blinding::secrets::OutputOpenings,
) -> anyhow::Result<WitnessValues> {
    let parameters = protocol.audit();
    let asset = protocol.config().regulated_asset;
    let mut rng = rand::thread_rng();
    let mut prepared = Vec::new();
    let mut manifest = Vec::new();
    for (index, output) in pset.outputs().iter().enumerate() {
        if output.asset != Some(asset) {
            continue;
        }
        let secret = openings
            .get(&index)
            .context("missing regulated output opening")?;
        let opening = AuditOpening::new(secret.value.try_into()?, secret.value_bf.into_inner())?;
        let commitment = output
            .amount_comm
            .context("regulated output must be confidential")?;
        let index = u32::try_from(index)?;
        let script_hash = sha256::Hash::hash(output.script_pubkey.as_bytes()).to_byte_array();
        let output = AuditOutput::new(
            index,
            crate::utxo::public_asset_id(asset),
            commitment,
            script_hash.into(),
        )?;
        let auxiliary = output.seal(&mut rng, parameters, &opening)?;
        manifest.extend(index.to_be_bytes());
        manifest.extend(auxiliary.as_ref());
        prepared.push((output, opening, auxiliary));
    }
    anyhow::ensure!(
        !prepared.is_empty() && prepared.len() <= 10,
        "expected one to ten regulated outputs"
    );
    manifest.extend(u32::try_from(prepared.len())?.to_be_bytes());
    let hash = sha256::Hash::hash(&manifest).to_byte_array();
    // Standard relay rejects a nonce on an explicit anchor. Commit the
    // manifest in a zero-value OP_RETURN output covered by every sig_all.
    let fee_asset = pset
        .outputs()
        .last()
        .and_then(|o| o.asset)
        .context("missing fee asset")?;
    let mut script = vec![0x6a, 0x20];
    script.extend(hash);
    pset.add_output(elements::pset::Output::new_explicit(
        elements::Script::from(script),
        0,
        fee_asset,
        None,
    ));
    let env = anchor.environment(pset, 0, AnchorBranch::Verifier, protocol.config().network)?;
    let sighash = env.c_tx_env().sighash_all().to_byte_array();
    let mut values = Vec::new();
    for (output, opening, auxiliary) in prepared {
        let index = output.index();
        let statement = AuditStatement::new(parameters, output, sighash.into(), auxiliary);
        let proof = NativeAuditProof::prove(&mut rng, &statement, &opening)?;
        let range = pset.outputs()[index as usize]
            .value_rangeproof
            .as_ref()
            .context("missing range proof")?
            .serialize();
        anyhow::ensure!(
            range.len() == 5070 && range[..10] == [0x60, 0x3e, 0, 0, 0, 0, 0, 0, 0, 1],
            "native range proof must use the fixed63bit interval"
        );
        values.push(record_value(
            index,
            proof.proof(),
            &auxiliary.to_byte_array(),
            &range[10..],
        )?);
    }
    let record_type = values[0].ty().clone();
    let count = values.len();
    let mut records = values.into_iter().map(Value::some).collect::<Vec<_>>();
    records.extend((count..10).map(|_| Value::none(record_type.clone())));
    let mut map: HashMap<_, _> = base.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    map.insert(
        WitnessName::from_str_unchecked("AUDIT_RECORDS"),
        Value::array(records, ResolvedType::option(record_type)),
    );
    Ok(map.into())
}

fn record_value(
    index: u32,
    proof: &NativeAuditProof,
    aux: &[u8; AUXILIARY_BYTES],
    range_body: &[u8],
) -> anyhow::Result<Value> {
    anyhow::ensure!(range_body.len() == 5060, "wrong native range body length");
    let aux = Value::tuple([
        Value::byte_array(aux[..64].iter().copied()),
        word(aux[64..96].try_into()?),
        Value::from(UIntValue::U32(u32::from_be_bytes(aux[96..100].try_into()?))),
        Value::from(UIntValue::U16(u16::from_be_bytes(aux[100..].try_into()?))),
    ]);
    let range = Value::tuple([
        Value::array(
            range_body[..5056]
                .as_chunks::<64>()
                .0
                .iter()
                .map(|c| Value::byte_array(c.iter().copied())),
            ResolvedType::array(ResolvedType::u8(), 64),
        ),
        Value::from(UIntValue::U32(u32::from_be_bytes(
            range_body[5056..].try_into()?,
        ))),
    ]);
    Ok(Value::tuple([
        Value::from(UIntValue::U32(index)),
        Value::from(UIntValue::U1(u8::from(proof.commitment_parity()))),
        word(proof.commitment_root()),
        point(proof.handle()),
        point(proof.commitment_nonce()),
        point(proof.handle_nonce()),
        word(proof.value_response()),
        word(proof.blinder_response()),
        aux,
        range,
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::covenant::policy::{IndexedInputPolicyProof, outpoint_key};
    use crate::covenant::program::ProtocolConfig;
    use damp_core::policy::{PolicySet, TreeDepth};
    use damp_core::registry::DeploymentNetwork;
    use elements::TxOutSecrets;
    use elements::{
        AssetId, OutPoint, Script, TxOut, Txid,
        confidential::{Asset, AssetBlindingFactor, Value as Amount, ValueBlindingFactor},
        pset::{Input, Output},
        secp256k1_zkp::{Keypair, Message, SecretKey},
    };
    fn fixture_protocol() -> anyhow::Result<(Protocol, SecretKey)> {
        let secp = elements::secp256k1_zkp::SECP256K1;
        let owner_secret = SecretKey::from_slice(&[4; 32])?;
        let owner_public = elements::secp256k1_zkp::PublicKey::from_secret_key(secp, &owner_secret);
        let owner = owner_public.x_only_public_key().0;
        let audit_key = elements::secp256k1_zkp::PublicKey::from_secret_key(
            secp,
            &SecretKey::from_slice(&[9; 32])?,
        );
        let asset = AssetId::from_byte_array([17; 32]);
        let anchor_asset = AssetId::from_byte_array([18; 32]);
        let protocol = Protocol::new(
            ProtocolConfig {
                regulated_asset: asset,
                verifier_asset: anchor_asset,
                verifier_asset_amount: 1,
                issuer: owner,
                network: DeploymentNetwork::ElementsRegtest,
            },
            damp_core::native_audit::AuditDomain::new(
                damp_core::registry::DeploymentSalt::try_from([42; 32])?,
                damp_core::registry::NativeAuditConfig {
                    epoch: damp_core::registry::AuditEpoch::INITIAL,
                    public_key: audit_key.into(),
                },
            ),
        )?;
        Ok((protocol, owner_secret))
    }

    #[test]
    fn variable_shape_native_anchor_and_holders_execute_with_real_rangeproofs() -> anyhow::Result<()>
    {
        let (protocol, owner_secret) = fixture_protocol()?;
        let secp = elements::secp256k1_zkp::SECP256K1;
        let owner_public = elements::secp256k1_zkp::PublicKey::from_secret_key(secp, &owner_secret);
        let owner = owner_public.x_only_public_key().0;
        let asset = protocol.config().regulated_asset;
        let anchor_asset = protocol.config().verifier_asset;
        let fee_asset = AssetId::from_byte_array([19; 32]);
        for depth in [TreeDepth::D4, TreeDepth::D5, TreeDepth::D6] {
            let policy = PolicySet::new(depth, [])?;
            let commitment = policy.commitment();
            let anchor = protocol.anchor(commitment)?;
            for count in [1usize, 2, 10] {
                let mut pset = PartiallySignedTransaction::new_v2();
                let mut inputs = HashMap::new();
                let mut proofs = Vec::new();
                for i in 0..count + 2 {
                    let (a, v, script) = if i == 0 {
                        (anchor_asset, 1, anchor.script_pubkey())
                    } else if i == count + 1 {
                        (fee_asset, 25000, Script::from(vec![0x51]))
                    } else {
                        (asset, 100, protocol.user_script(owner)?)
                    };
                    let outpoint =
                        OutPoint::new(Txid::from_byte_array([i as u8 + 1; 32]), i as u32);
                    let mut input = Input::from_prevout(outpoint);
                    input.witness_utxo = Some(TxOut {
                        asset: Asset::Explicit(a),
                        value: Amount::Explicit(v),
                        script_pubkey: script,
                        ..Default::default()
                    });
                    input.asset = Some(a);
                    input.amount = Some(v);
                    pset.add_input(input);
                    inputs.insert(
                        i,
                        TxOutSecrets::new(
                            a,
                            AssetBlindingFactor::zero(),
                            v,
                            ValueBlindingFactor::zero(),
                        ),
                    );
                    if i > 0 && i <= count {
                        proofs.push(IndexedInputPolicyProof::new(
                            i as u32,
                            policy.non_membership_proof(outpoint_key(outpoint))?,
                        ));
                    }
                }
                pset.add_output(Output::new_explicit(
                    anchor.script_pubkey(),
                    1,
                    anchor_asset,
                    None,
                ));
                for _ in 0..count {
                    pset.add_output(Output::new_explicit(
                        protocol.user_script(owner)?,
                        100,
                        asset,
                        Some(elements::bitcoin::PublicKey::new(owner_public)),
                    ));
                }
                pset.add_output(Output::new_explicit(
                    Script::from(vec![0x51]),
                    24000,
                    fee_asset,
                    Some(elements::bitcoin::PublicKey::new(owner_public)),
                ));
                pset.add_output(Output::new_explicit(Script::new(), 1000, fee_asset, None));
                let borrowed_inputs = inputs
                    .iter()
                    .map(|(index, opening)| (*index, opening))
                    .collect();
                let openings = crate::blinding::blind_audited_values(
                    &mut pset,
                    &borrowed_inputs,
                    &(1..=count + 1).collect::<Vec<_>>(),
                    asset,
                )?;
                let mut recipients = [None; 10];
                recipients[..count].fill(Some(owner));
                let base = Protocol::transfer_witness(commitment, owner, recipients, &proofs)?;
                let witness = transfer_witness(&mut pset, &protocol, &anchor, base, &openings)?;
                let stack = anchor.finalize(
                    &pset,
                    &witness,
                    0,
                    AnchorBranch::Verifier,
                    protocol.config().network,
                )?;
                if count == 1 {
                    // Change witness-only fields, leaving the Sigma transcript and
                    // transaction intact so these checks exercise their own guards.
                    let empty = Protocol::transfer_witness(commitment, owner, recipients, &[])?;
                    let empty: HashMap<_, _> = empty
                        .iter()
                        .map(|(name, value)| (name.clone(), value.clone()))
                        .collect();
                    for (name, value) in [
                        ("TRANSFER_OWNER", word([1; 32])),
                        (
                            "INPUT_POLICY_PROOFS",
                            empty[&WitnessName::from_str_unchecked("INPUT_POLICY_PROOFS")].clone(),
                        ),
                        (
                            "BUDGET_PADDING",
                            Value::array(
                                (0..crate::covenant::program::BUDGET_WORDS).map(|_| word([1; 32])),
                                ResolvedType::u256(),
                            ),
                        ),
                    ] {
                        let mut invalid: HashMap<_, _> = witness
                            .iter()
                            .map(|(name, value)| (name.clone(), value.clone()))
                            .collect();
                        invalid.insert(WitnessName::from_str_unchecked(name), value);
                        assert!(
                            anchor
                                .finalize(
                                    &pset,
                                    &invalid.into(),
                                    0,
                                    AnchorBranch::Verifier,
                                    protocol.config().network
                                )
                                .is_err(),
                            "{name}"
                        );
                    }
                }
                println!(
                    "native depth={depth:?} regulated outputs={count} anchor stack bytes={}",
                    elements::encode::serialize(&stack).len()
                );
                pset.inputs_mut()[0].final_script_witness = Some(stack);
                for index in 1..=count {
                    let user = protocol.user_program(owner)?;
                    let env = user.environment(&pset, index, protocol.config().network)?;
                    let signature = secp.sign_schnorr_no_aux_rand(
                        &Message::from_digest(env.c_tx_env().sighash_all().to_byte_array()),
                        &Keypair::from_secret_key(secp, &owner_secret),
                    );
                    if index == 1 {
                        let wrong = secp.sign_schnorr_no_aux_rand(
                            &Message::from_digest(env.c_tx_env().sighash_all().to_byte_array()),
                            &Keypair::from_secret_key(secp, &SecretKey::from_slice(&[8; 32])?),
                        );
                        assert!(protocol.finalize_user(&pset, owner, wrong, index).is_err());
                    }
                    pset.inputs_mut()[index].final_script_witness =
                        Some(protocol.finalize_user(&pset, owner, signature, index)?);
                }
                let tx = pset.extract_tx()?;
                let spent = pset
                    .inputs()
                    .iter()
                    .map(|i| i.witness_utxo.clone().unwrap())
                    .collect::<Vec<_>>();
                crate::transaction::verify_transaction_amounts(&tx, &spent)?;
                assert!(tx.weight() < 400000, "standard weight bound");
            }
        }
        Ok(())
    }

    #[test]
    fn governance_requires_issuer_and_exact_anchor_quantity() -> anyhow::Result<()> {
        let (protocol, issuer) = fixture_protocol()?;
        let secp = elements::secp256k1_zkp::SECP256K1;
        let wrong_issuer = SecretKey::from_slice(&[8; 32])?;
        for depth in [TreeDepth::D4, TreeDepth::D5, TreeDepth::D6] {
            let anchor = protocol.anchor(PolicySet::new(depth, [])?.commitment())?;
            for (input_amount, output_amount, correct_issuer, accepted) in [
                (1, 1, true, true),
                (2, 1, true, false),
                (1, 0, true, false),
                (1, 2, true, false),
                (1, 1, false, false),
            ] {
                let mut pset = PartiallySignedTransaction::new_v2();
                let mut input =
                    Input::from_prevout(OutPoint::new(Txid::from_byte_array([3; 32]), 0));
                input.witness_utxo = Some(TxOut {
                    asset: Asset::Explicit(protocol.config().verifier_asset),
                    value: Amount::Explicit(input_amount),
                    script_pubkey: anchor.script_pubkey(),
                    ..Default::default()
                });
                pset.add_input(input);
                // Governance deliberately permits an arbitrary successor script.
                pset.add_output(Output::new_explicit(
                    Script::from(vec![0x51]),
                    output_amount,
                    protocol.config().verifier_asset,
                    None,
                ));
                let env = anchor.environment(
                    &pset,
                    0,
                    AnchorBranch::Governance,
                    protocol.config().network,
                )?;
                let signature = secp.sign_schnorr_no_aux_rand(
                    &Message::from_digest(env.c_tx_env().sighash_all().to_byte_array()),
                    &Keypair::from_secret_key(
                        secp,
                        if correct_issuer {
                            &issuer
                        } else {
                            &wrong_issuer
                        },
                    ),
                );
                let result = anchor.finalize(
                    &pset,
                    &Protocol::governance_witness(signature),
                    0,
                    AnchorBranch::Governance,
                    protocol.config().network,
                );
                assert_eq!(
                    result.is_ok(),
                    accepted,
                    "depth={depth:?}, input={input_amount}, output={output_amount}, issuer={correct_issuer}"
                );
            }
        }
        Ok(())
    }
}
