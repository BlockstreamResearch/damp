//! Generation-2 public audit records and their transaction-authenticated envelope manifest.
use crate::protocol::{AUDIT_BUDGET_WORDS, AnchorBranch, CompiledAnchor, Protocol};
use amp_core::native_audit::{
    AUXILIARY_BYTES, AuditOpening, AuditStatement, NativeAuditProof, recovery_context, seal_opening,
};
use anyhow::Context;
use elements::{
    TxOutSecrets,
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
    openings: &HashMap<usize, TxOutSecrets>,
) -> anyhow::Result<WitnessValues> {
    let parameters = protocol.audit().context("audited deployment required")?;
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
        let opening = AuditOpening::new(secret.value, *secret.value_bf.into_inner().as_ref())?;
        let commitment = output
            .amount_comm
            .context("regulated output must be confidential")?;
        let index = u32::try_from(index)?;
        let script_hash = sha256::Hash::hash(output.script_pubkey.as_bytes()).to_byte_array();
        let context = recovery_context(
            parameters.deployment,
            parameters.epoch,
            index,
            asset.into_inner().to_byte_array(),
            commitment,
            script_hash,
        );
        let auxiliary = seal_opening(&mut rng, parameters.key, context, &opening)?;
        manifest.extend(index.to_be_bytes());
        manifest.extend(auxiliary);
        prepared.push((index, opening, commitment, script_hash, auxiliary));
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
    for (index, opening, commitment, script_hash, auxiliary) in prepared {
        let statement = AuditStatement {
            deployment: parameters.deployment,
            epoch: parameters.epoch,
            audit_key: parameters.key,
            sig_all_hash: sighash,
            output_index: index,
            asset: asset.into_inner().to_byte_array(),
            commitment,
            script_hash,
            auxiliary,
        };
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
        values.push(record_value(index, &proof, &auxiliary, &range[10..])?);
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
    map.insert(
        WitnessName::from_str_unchecked("BUDGET_PADDING"),
        Value::array(
            (0..AUDIT_BUDGET_WORDS).map(|_| word([0; 32])),
            ResolvedType::u256(),
        ),
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
        Value::from(UIntValue::U1(u8::from(proof.commitment_parity))),
        word(proof.commitment_root),
        point(proof.handle),
        point(proof.commitment_nonce),
        point(proof.handle_nonce),
        word(proof.value_response),
        word(proof.blinder_response),
        aux,
        range,
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{IndexedInputPolicyProof, outpoint_key};
    use crate::protocol::ProtocolConfig;
    use amp_core::policy::{PolicySet, TreeDepth};
    use amp_core::registry::DeploymentNetwork;
    use elements::{
        AssetId, OutPoint, Script, TxOut, Txid,
        confidential::{Asset, AssetBlindingFactor, Value as Amount, ValueBlindingFactor},
        pset::{Input, Output},
        secp256k1_zkp::{Keypair, Message, SecretKey},
    };
    #[test]
    fn variable_shape_native_anchor_and_holders_execute_with_real_rangeproofs() -> anyhow::Result<()>
    {
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
        let fee_asset = AssetId::from_byte_array([19; 32]);
        let protocol = Protocol::new_audited(
            ProtocolConfig {
                regulated_asset: asset,
                verifier_asset: anchor_asset,
                verifier_asset_amount: 1,
                issuer: owner,
                network: DeploymentNetwork::ElementsRegtest,
            },
            crate::protocol::AuditParameters {
                deployment: [42; 32],
                epoch: 1,
                key: audit_key,
            },
        )?;
        let policy = PolicySet::new(TreeDepth::D6, Vec::<[u8; 32]>::new())?;
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
                let outpoint = OutPoint::new(Txid::from_byte_array([i as u8 + 1; 32]), i as u32);
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
            let openings = crate::blinding::blind_audited_values(
                &mut pset,
                &inputs,
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
            println!(
                "audited regulated outputs={count} anchor stack bytes={}",
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
        Ok(())
    }
}
