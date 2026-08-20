use simplicity_amp::blacklist::BlacklistPolicy;
use simplicity_amp::policy::{IndexedInputPolicyProof, PolicySet, TreeDepth, outpoint_key};
use simplicity_amp::protocol::{AnchorBranch, Protocol, ProtocolConfig};

use simplex::program::ProgramTrait;
use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::elements::confidential;
use simplex::simplicityhl::elements::hashes::Hash;
use simplex::simplicityhl::elements::pset::{Input, Output, PartiallySignedTransaction};
use simplex::simplicityhl::elements::schnorr::{Keypair, XOnlyPublicKey};
use simplex::simplicityhl::elements::secp256k1_zkp::schnorr::Signature;
use simplex::simplicityhl::elements::secp256k1_zkp::{Message, SECP256K1, SecretKey};
use simplex::simplicityhl::elements::{AssetId, OutPoint, Script, TxOut, Txid};

struct Fixture {
    protocol: Protocol,
    network: SimplicityNetwork,
    regulated_asset: AssetId,
    verifier_asset: AssetId,
    issuer: Keypair,
    owner: Keypair,
    recipient: Keypair,
}

impl Fixture {
    fn new() -> anyhow::Result<Self> {
        let network = SimplicityNetwork::default_regtest();
        let regulated_asset = asset(0x11)?;
        let verifier_asset = asset(0x22)?;
        let issuer = keypair(1)?;
        let owner = keypair(2)?;
        let recipient = keypair(3)?;
        let protocol = Protocol::new(ProtocolConfig {
            regulated_asset,
            verifier_asset,
            verifier_asset_amount: 1,
            issuer: issuer.x_only_public_key().0,
            network,
        })?;
        Ok(Self {
            protocol,
            network,
            regulated_asset,
            verifier_asset,
            issuer,
            owner,
            recipient,
        })
    }

    fn owner(&self) -> XOnlyPublicKey {
        self.owner.x_only_public_key().0
    }

    fn recipient(&self) -> XOnlyPublicKey {
        self.recipient.x_only_public_key().0
    }

    fn transfer(
        &self,
        input_policy: amp_core::SetCommitment,
        output_script: Script,
    ) -> anyhow::Result<PartiallySignedTransaction> {
        let mut pset = PartiallySignedTransaction::new_v2();
        add_input(
            &mut pset,
            input_outpoint(0)?,
            txout(
                self.protocol.verifier_script(input_policy)?,
                self.verifier_asset,
                1,
            ),
        )?;
        add_input(
            &mut pset,
            input_outpoint(1)?,
            txout(
                self.protocol.user_script(self.owner()),
                self.regulated_asset,
                1_000,
            ),
        )?;
        pset.add_output(Output::new_explicit(
            output_script,
            1,
            self.verifier_asset,
            None,
        ));
        pset.add_output(Output::new_explicit(
            self.protocol.user_script(self.recipient()),
            1_000,
            self.regulated_asset,
            None,
        ));
        Ok(pset)
    }
}

#[test]
fn all_supported_depths_compile_distinct_transfer_leaves_with_one_governance_leaf()
-> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let mut governance_hash = None;
    let mut scripts = Vec::new();
    for depth in [TreeDepth::D4, TreeDepth::D5, TreeDepth::D6] {
        let policy = PolicySet::new(depth, [])?.commitment();
        let anchor = fixture.protocol.anchor(policy)?;
        assert_eq!(anchor.depth(), depth);
        assert_eq!(
            anchor
                .control_block(AnchorBranch::Verifier)?
                .merkle_branch
                .as_inner()
                .len(),
            1
        );
        assert_eq!(
            anchor
                .control_block(AnchorBranch::Governance)?
                .merkle_branch
                .as_inner()
                .len(),
            1
        );
        if let Some(expected) = governance_hash {
            assert_eq!(anchor.governance_program_hash(), expected);
        } else {
            governance_hash = Some(anchor.governance_program_hash());
        }
        scripts.push(anchor.script_pubkey());
    }
    assert!(scripts.windows(2).all(|pair| pair[0] != pair[1]));
    Ok(())
}

#[test]
fn ordinary_transfer_preserves_anchor_and_executes_both_covenants() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let blacklist = BlacklistPolicy::empty(TreeDepth::D4)?;
    let policy = blacklist.commitment();
    let anchor = fixture.protocol.anchor(policy)?;
    let pset = fixture.transfer(policy, anchor.script_pubkey())?;
    let proof = blacklist.prove_input(1, input_outpoint(1)?)?;
    let verifier_witness = Protocol::transfer_witness(
        policy,
        fixture.owner(),
        recipient_slots(&[fixture.recipient()]),
        &[proof],
    )?;
    anchor.execute(
        &pset,
        &verifier_witness,
        0,
        AnchorBranch::Verifier,
        &fixture.network,
    )?;
    let verifier_final = anchor.finalize(
        &pset,
        &verifier_witness,
        0,
        AnchorBranch::Verifier,
        &fixture.network,
    )?;
    assert_eq!(verifier_final.len(), 4);

    let user_program = fixture.protocol.user_program(fixture.owner());
    let signature = sign_program(
        user_program.as_ref(),
        &pset,
        1,
        &fixture.network,
        &fixture.owner,
    )?;
    user_program.as_ref().execute(
        &pset,
        &Protocol::user_witness(fixture.owner(), signature),
        1,
        &fixture.network,
    )?;
    let final_witness =
        fixture
            .protocol
            .finalize_user(&pset, fixture.owner(), signature, 1, &fixture.network)?;
    assert_eq!(final_witness.len(), 4);
    Ok(())
}

#[test]
fn transfer_branch_cannot_change_depth_or_policy_script() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let current = PolicySet::new(TreeDepth::D4, [])?.commitment();
    let successor = PolicySet::new(TreeDepth::D5, [])?.commitment();
    let current_anchor = fixture.protocol.anchor(current)?;
    let pset = fixture.transfer(current, fixture.protocol.verifier_script(successor)?)?;
    let blacklist = BlacklistPolicy::empty(TreeDepth::D4)?;
    let witness = Protocol::transfer_witness(
        current,
        fixture.owner(),
        recipient_slots(&[fixture.recipient()]),
        &[blacklist.prove_input(1, input_outpoint(1)?)?],
    )?;
    assert!(
        current_anchor
            .execute(&pset, &witness, 0, AnchorBranch::Verifier, &fixture.network,)
            .is_err()
    );
    Ok(())
}

#[test]
fn issuer_governance_upgrades_d4_to_d5_and_d5_to_d6() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    for (current_depth, successor_depth) in [
        (TreeDepth::D4, TreeDepth::D5),
        (TreeDepth::D5, TreeDepth::D6),
    ] {
        let current = PolicySet::new(current_depth, [])?.commitment();
        let successor = PolicySet::new(successor_depth, [])?.commitment();
        let anchor = fixture.protocol.anchor(current)?;
        let successor_script = fixture.protocol.verifier_script(successor)?;
        let pset = governance_pset(
            &fixture,
            anchor.script_pubkey(),
            successor_script,
            fixture.verifier_asset,
            1,
        )?;
        let signature = sign_anchor(
            &anchor,
            &pset,
            AnchorBranch::Governance,
            &fixture.network,
            &fixture.issuer,
        )?;
        anchor.execute(
            &pset,
            &Protocol::governance_witness(signature),
            0,
            AnchorBranch::Governance,
            &fixture.network,
        )?;
        let final_witness = anchor.finalize(
            &pset,
            &Protocol::governance_witness(signature),
            0,
            AnchorBranch::Governance,
            &fixture.network,
        )?;
        assert_eq!(final_witness.len(), 4);
    }

    // Governance deliberately supports recovery or shutdown outside the bundled verifier set.
    let current = PolicySet::new(TreeDepth::D4, [])?.commitment();
    let anchor = fixture.protocol.anchor(current)?;
    let pset = governance_pset(
        &fixture,
        anchor.script_pubkey(),
        Script::from(vec![0x51]),
        fixture.verifier_asset,
        1,
    )?;
    let signature = sign_anchor(
        &anchor,
        &pset,
        AnchorBranch::Governance,
        &fixture.network,
        &fixture.issuer,
    )?;
    anchor.execute(
        &pset,
        &Protocol::governance_witness(signature),
        0,
        AnchorBranch::Governance,
        &fixture.network,
    )?;
    Ok(())
}

#[test]
fn governance_rejects_wrong_issuer_or_verifier_quantity() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let policy = PolicySet::new(TreeDepth::D4, [])?.commitment();
    let anchor = fixture.protocol.anchor(policy)?;
    let valid = governance_pset(
        &fixture,
        anchor.script_pubkey(),
        anchor.script_pubkey(),
        fixture.verifier_asset,
        1,
    )?;
    let wrong_key = keypair(9)?;
    let wrong_signature = sign_anchor(
        &anchor,
        &valid,
        AnchorBranch::Governance,
        &fixture.network,
        &wrong_key,
    )?;
    assert!(
        anchor
            .execute(
                &valid,
                &Protocol::governance_witness(wrong_signature),
                0,
                AnchorBranch::Governance,
                &fixture.network,
            )
            .is_err()
    );

    let wrong_amount = governance_pset(
        &fixture,
        anchor.script_pubkey(),
        anchor.script_pubkey(),
        fixture.verifier_asset,
        2,
    )?;
    let signature = sign_anchor(
        &anchor,
        &wrong_amount,
        AnchorBranch::Governance,
        &fixture.network,
        &fixture.issuer,
    )?;
    assert!(
        anchor
            .execute(
                &wrong_amount,
                &Protocol::governance_witness(signature),
                0,
                AnchorBranch::Governance,
                &fixture.network,
            )
            .is_err()
    );

    let wrong_asset = governance_pset(
        &fixture,
        anchor.script_pubkey(),
        anchor.script_pubkey(),
        asset(0x33)?,
        1,
    )?;
    let signature = sign_anchor(
        &anchor,
        &wrong_asset,
        AnchorBranch::Governance,
        &fixture.network,
        &fixture.issuer,
    )?;
    assert!(
        anchor
            .execute(
                &wrong_asset,
                &Protocol::governance_witness(signature),
                0,
                AnchorBranch::Governance,
                &fixture.network,
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn transfer_rejects_blacklisted_input_missing_proof_and_fake_holder() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let spent = input_outpoint(1)?;
    let tree = PolicySet::new(TreeDepth::D4, [outpoint_key(spent)])?;
    let policy = tree.commitment();
    let anchor = fixture.protocol.anchor(policy)?;
    let pset = fixture.transfer(policy, anchor.script_pubkey())?;

    // Supplying a valid proof for another outpoint cannot authorize the blacklisted input.
    let forged = IndexedInputPolicyProof::new(
        1,
        tree.non_membership_proof(outpoint_key(input_outpoint(2)?))?,
    );
    let witness = Protocol::transfer_witness(
        policy,
        fixture.owner(),
        recipient_slots(&[fixture.recipient()]),
        &[forged],
    )?;
    assert!(
        anchor
            .execute(&pset, &witness, 0, AnchorBranch::Verifier, &fixture.network)
            .is_err()
    );

    let empty = PolicySet::new(TreeDepth::D4, [])?.commitment();
    let empty_anchor = fixture.protocol.anchor(empty)?;
    let pset = fixture.transfer(empty, empty_anchor.script_pubkey())?;
    let missing = Protocol::transfer_witness(
        empty,
        fixture.owner(),
        recipient_slots(&[fixture.recipient()]),
        &[],
    )?;
    assert!(
        empty_anchor
            .execute(&pset, &missing, 0, AnchorBranch::Verifier, &fixture.network,)
            .is_err()
    );

    let mut fake_holder = pset;
    fake_holder.inputs_mut()[1].witness_utxo = Some(txout(
        fixture.protocol.user_script(fixture.recipient()),
        fixture.regulated_asset,
        1_000,
    ));
    let proof = PolicySet::new(TreeDepth::D4, [])?.non_membership_proof(outpoint_key(spent))?;
    let witness = Protocol::transfer_witness(
        empty,
        fixture.owner(),
        recipient_slots(&[fixture.recipient()]),
        &[IndexedInputPolicyProof::new(1, proof)],
    )?;
    assert!(
        empty_anchor
            .execute(
                &fake_holder,
                &witness,
                0,
                AnchorBranch::Verifier,
                &fixture.network,
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn transfer_rejects_wrong_verifier_asset_and_eleventh_regulated_output() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let blacklist = BlacklistPolicy::empty(TreeDepth::D4)?;
    let policy = blacklist.commitment();
    let anchor = fixture.protocol.anchor(policy)?;
    let proof = blacklist.prove_input(1, input_outpoint(1)?)?;
    let witness = Protocol::transfer_witness(
        policy,
        fixture.owner(),
        [Some(fixture.recipient()); 10],
        &[proof],
    )?;

    let mut wrong_asset = fixture.transfer(policy, anchor.script_pubkey())?;
    wrong_asset.inputs_mut()[0].asset = Some(asset(0x33)?);
    wrong_asset.inputs_mut()[0].witness_utxo = Some(txout(anchor.script_pubkey(), asset(0x33)?, 1));
    assert!(
        anchor
            .execute(
                &wrong_asset,
                &witness,
                0,
                AnchorBranch::Verifier,
                &fixture.network,
            )
            .is_err()
    );

    let mut too_many_outputs = fixture.transfer(policy, anchor.script_pubkey())?;
    for _ in 0..10 {
        too_many_outputs.add_output(Output::new_explicit(
            fixture.protocol.user_script(fixture.recipient()),
            1,
            fixture.regulated_asset,
            None,
        ));
    }
    assert!(
        anchor
            .execute(
                &too_many_outputs,
                &witness,
                0,
                AnchorBranch::Verifier,
                &fixture.network,
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn wrong_depth_proofs_are_rejected_before_signing() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    let input = input_outpoint(1)?;
    let allowed = PolicySet::new(TreeDepth::D4, [])?;
    let wrong_depth = PolicySet::new(TreeDepth::D5, [[0x80; 32]])?;
    let proof =
        IndexedInputPolicyProof::new(1, wrong_depth.non_membership_proof(outpoint_key(input))?);
    assert!(
        Protocol::transfer_witness(
            allowed.commitment(),
            fixture.owner(),
            recipient_slots(&[fixture.recipient()]),
            &[proof],
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn maximum_ten_input_ten_output_transfer_uses_recorded_minimal_padding() -> anyhow::Result<()> {
    let fixture = Fixture::new()?;
    for depth in [TreeDepth::D4, TreeDepth::D5, TreeDepth::D6] {
        let blacklist = PolicySet::new(depth, [[0; 32], [0xff; 32]])?;
        let policy = blacklist.commitment();
        let anchor = fixture.protocol.anchor(policy)?;
        let mut pset = PartiallySignedTransaction::new_v2();
        add_input(
            &mut pset,
            input_outpoint(0)?,
            txout(anchor.script_pubkey(), fixture.verifier_asset, 1),
        )?;
        let mut proofs = Vec::new();
        for index in 1..=10 {
            let outpoint = input_outpoint(index)?;
            proofs.push(IndexedInputPolicyProof::new(
                u32::from(index),
                blacklist.non_membership_proof(outpoint_key(outpoint))?,
            ));
            add_input(
                &mut pset,
                outpoint,
                txout(
                    fixture.protocol.user_script(fixture.owner()),
                    fixture.regulated_asset,
                    100,
                ),
            )?;
        }
        add_input(
            &mut pset,
            input_outpoint(11)?,
            txout(Script::new(), fixture.network.policy_asset(), 25_000),
        )?;
        pset.add_output(Output::new_explicit(
            anchor.script_pubkey(),
            1,
            fixture.verifier_asset,
            None,
        ));
        for _ in 0..10 {
            pset.add_output(Output::new_explicit(
                fixture.protocol.user_script(fixture.recipient()),
                100,
                fixture.regulated_asset,
                None,
            ));
        }
        pset.add_output(Output::new_explicit(
            Script::new(),
            25_000,
            fixture.network.policy_asset(),
            None,
        ));
        let witness = Protocol::transfer_witness(
            policy,
            fixture.owner(),
            [Some(fixture.recipient()); 10],
            &proofs,
        )?;
        let metrics = anchor.execution_metrics(
            &pset,
            &witness,
            0,
            AnchorBranch::Verifier,
            &fixture.network,
        )?;
        eprintln!(
            "D{}: witness={} bytes, execution={} milliweight, padding={} bytes",
            depth.as_u8(),
            metrics.witness_bytes,
            metrics.execution_milliweight,
            metrics.required_padding_bytes,
        );
        let expected = match depth {
            TreeDepth::D4 => (15_835, 15_053_549, 0),
            TreeDepth::D5 => (18_104, 16_617_840, 0),
            TreeDepth::D6 => (20_408, 18_368_883, 0),
        };
        assert_eq!(
            (
                metrics.witness_bytes,
                metrics.execution_milliweight,
                metrics.required_padding_bytes
            ),
            expected,
        );

        let mut ordinary = fixture.transfer(policy, anchor.script_pubkey())?;
        add_input(
            &mut ordinary,
            input_outpoint(11)?,
            txout(Script::new(), fixture.network.policy_asset(), 25_000),
        )?;
        ordinary.add_output(Output::new_explicit(
            fixture.protocol.user_script(fixture.owner()),
            900,
            fixture.regulated_asset,
            None,
        ));
        ordinary.add_output(Output::new_explicit(
            Script::new(),
            25_000,
            fixture.network.policy_asset(),
            None,
        ));
        let proof = IndexedInputPolicyProof::new(
            1,
            blacklist.non_membership_proof(outpoint_key(input_outpoint(1)?))?,
        );
        let ordinary_witness = Protocol::transfer_witness(
            policy,
            fixture.owner(),
            recipient_slots(&[fixture.recipient(), fixture.owner()]),
            &[proof],
        )?;
        let ordinary_metrics = anchor.execution_metrics(
            &ordinary,
            &ordinary_witness,
            0,
            AnchorBranch::Verifier,
            &fixture.network,
        )?;
        eprintln!(
            "D{} ordinary: witness={} bytes, execution={} milliweight, padding={} bytes",
            depth.as_u8(),
            ordinary_metrics.witness_bytes,
            ordinary_metrics.execution_milliweight,
            ordinary_metrics.required_padding_bytes,
        );
        let expected_ordinary = match depth {
            TreeDepth::D4 => (12_624, 12_668_815, 0),
            TreeDepth::D5 => (14_317, 14_340_306, 0),
            TreeDepth::D6 => (16_045, 16_091_349, 0),
        };
        assert_eq!(
            (
                ordinary_metrics.witness_bytes,
                ordinary_metrics.execution_milliweight,
                ordinary_metrics.required_padding_bytes
            ),
            expected_ordinary,
        );
    }
    Ok(())
}

fn governance_pset(
    fixture: &Fixture,
    input_script: Script,
    output_script: Script,
    output_asset: AssetId,
    output_amount: u64,
) -> anyhow::Result<PartiallySignedTransaction> {
    let mut pset = PartiallySignedTransaction::new_v2();
    add_input(
        &mut pset,
        input_outpoint(0)?,
        txout(input_script, fixture.verifier_asset, 1),
    )?;
    pset.add_output(Output::new_explicit(
        output_script,
        output_amount,
        output_asset,
        None,
    ));
    Ok(pset)
}

fn recipient_slots(recipients: &[XOnlyPublicKey]) -> [Option<XOnlyPublicKey>; 10] {
    let mut slots = [None; 10];
    for (slot, recipient) in slots.iter_mut().zip(recipients) {
        *slot = Some(*recipient);
    }
    slots
}

fn keypair(byte: u8) -> anyhow::Result<Keypair> {
    let secret = SecretKey::from_slice(&[byte; 32])?;
    Ok(Keypair::from_secret_key(SECP256K1, &secret))
}

fn asset(byte: u8) -> anyhow::Result<AssetId> {
    let mut bytes = [0; 32];
    for (offset, value) in bytes.iter_mut().enumerate() {
        *value = byte.wrapping_add(offset as u8);
    }
    Ok(AssetId::from_slice(&bytes)?)
}

fn txout(script_pubkey: Script, asset: AssetId, amount: u64) -> TxOut {
    TxOut {
        asset: confidential::Asset::Explicit(asset),
        value: confidential::Value::Explicit(amount),
        script_pubkey,
        ..Default::default()
    }
}

fn add_input(
    pset: &mut PartiallySignedTransaction,
    outpoint: OutPoint,
    witness_utxo: TxOut,
) -> anyhow::Result<()> {
    let mut input = Input::from_prevout(outpoint);
    input.amount = witness_utxo.value.explicit();
    input.asset = witness_utxo.asset.explicit();
    input.witness_utxo = Some(witness_utxo);
    pset.add_input(input);
    Ok(())
}

fn input_outpoint(index: u8) -> anyhow::Result<OutPoint> {
    let mut txid = [0; 32];
    for (offset, byte) in txid.iter_mut().enumerate() {
        *byte = index.wrapping_add(offset as u8).wrapping_add(1);
    }
    Ok(OutPoint::new(Txid::from_slice(&txid)?, u32::from(index)))
}

fn sign_program(
    program: &simplex::program::Program,
    pset: &PartiallySignedTransaction,
    input_index: usize,
    network: &SimplicityNetwork,
    key: &Keypair,
) -> anyhow::Result<Signature> {
    let env = program.get_env(pset, input_index, network)?;
    let message = Message::from_digest(env.c_tx_env().sighash_all().to_byte_array());
    Ok(SECP256K1.sign_schnorr(&message, key))
}

fn sign_anchor(
    anchor: &simplicity_amp::protocol::CompiledAnchor,
    pset: &PartiallySignedTransaction,
    branch: AnchorBranch,
    network: &SimplicityNetwork,
    key: &Keypair,
) -> anyhow::Result<Signature> {
    let env = anchor.environment(pset, 0, branch, network)?;
    let message = Message::from_digest(env.c_tx_env().sighash_all().to_byte_array());
    Ok(SECP256K1.sign_schnorr(&message, key))
}
