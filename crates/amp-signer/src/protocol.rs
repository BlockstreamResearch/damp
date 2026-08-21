//! Browser-safe AMP covenant compilation and finalization.
//!
//! This module intentionally depends on `simplicityhl` directly. The broader
//! Simplex SDK also includes node, RPC, and regtest tooling that does not belong
//! in a signer compiled for the browser.

use std::collections::HashMap;
use std::sync::Arc;

use amp_core::policy::{Hash32, NeighborProof, SetCommitment, TreeDepth};
use amp_core::registry::DeploymentNetwork;
use elements::hashes::{Hash as _, HashEngine as _, sha256};
use elements::pset::PartiallySignedTransaction;
use elements::schnorr::XOnlyPublicKey;
use elements::secp256k1_zkp::{self as secp256k1, schnorr::Signature};
use elements::taproot::{ControlBlock, TapLeafHash, TaprootBuilder, TaprootSpendInfo};
use elements::{AddressParams, AssetId, BlockHash, Script, Transaction};
use simplicityhl::ast::ElementsJetHinter;
use simplicityhl::num::U256;
use simplicityhl::simplicity::jet::elements::{ElementsEnv, ElementsUtxo};
use simplicityhl::simplicity::{BitMachine, Cmr, RedeemNode, leaf_version};
use simplicityhl::str::WitnessName;
use simplicityhl::tracker::DefaultTracker;
use simplicityhl::types::TypeConstructible;
use simplicityhl::value::{UIntValue, ValueConstructible};
use simplicityhl::{
    Arguments, CompiledProgram, ResolvedType, TemplateProgram, UnstableFeatures, Value,
    WitnessValues,
};

use crate::policy::IndexedInputPolicyProof;

pub const MAX_REGULATED_INPUTS: usize = 10;
pub const MAX_REGULATED_OUTPUTS: usize = 10;
pub const D4_BUDGET_PADDING_WORDS: usize = 278;
pub const D5_BUDGET_PADDING_WORDS: usize = 329;
pub const D6_BUDGET_PADDING_WORDS: usize = 380;

const USER_SOURCE: &str = include_str!("../../../src/artifacts/simf/user.simf");
const GOVERNANCE_SOURCE: &str = include_str!("../../../src/artifacts/simf/governance.simf");
const VERIFIER_D4_SOURCE: &str = include_str!("../../../src/artifacts/simf/verifier.simf");
const VERIFIER_D5_SOURCE: &str = include_str!("../../../src/artifacts/simf/verifier_d5.simf");
const VERIFIER_D6_SOURCE: &str = include_str!("../../../src/artifacts/simf/verifier_d6.simf");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolConfig {
    pub regulated_asset: AssetId,
    pub verifier_asset: AssetId,
    pub verifier_asset_amount: u64,
    pub issuer: XOnlyPublicKey,
    pub network: DeploymentNetwork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorBranch {
    Verifier,
    Governance,
}

#[derive(Debug)]
pub struct CompiledAnchor {
    verifier: CompiledProgram,
    governance: CompiledProgram,
    spend_info: TaprootSpendInfo,
}

impl CompiledAnchor {
    #[must_use]
    pub fn verifier_program_hash(&self) -> [u8; 32] {
        leaf_hash(self.verifier.commit().cmr()).to_byte_array()
    }

    #[must_use]
    pub fn governance_program_hash(&self) -> [u8; 32] {
        leaf_hash(self.governance.commit().cmr()).to_byte_array()
    }

    #[must_use]
    pub fn script_pubkey(&self) -> Script {
        Script::new_v1_p2tr_tweaked(self.spend_info.output_key())
    }

    fn program(&self, branch: AnchorBranch) -> &CompiledProgram {
        match branch {
            AnchorBranch::Verifier => &self.verifier,
            AnchorBranch::Governance => &self.governance,
        }
    }

    fn cmr(&self, branch: AnchorBranch) -> Cmr {
        self.program(branch).commit().cmr()
    }

    fn control_block(&self, branch: AnchorBranch) -> anyhow::Result<ControlBlock> {
        self.spend_info
            .control_block(&(
                Script::from(self.cmr(branch).as_ref().to_vec()),
                leaf_version(),
            ))
            .ok_or_else(|| anyhow::anyhow!("missing AMP {branch:?} control block"))
    }

    pub fn environment(
        &self,
        pset: &PartiallySignedTransaction,
        input_index: usize,
        branch: AnchorBranch,
        network: DeploymentNetwork,
    ) -> anyhow::Result<ElementsEnv<Arc<Transaction>>> {
        build_environment(
            pset,
            input_index,
            self.cmr(branch),
            self.control_block(branch)?,
            &self.script_pubkey(),
            network,
        )
    }

    pub fn finalize(
        &self,
        pset: &PartiallySignedTransaction,
        witness: &WitnessValues,
        input_index: usize,
        branch: AnchorBranch,
        network: DeploymentNetwork,
    ) -> anyhow::Result<Vec<Vec<u8>>> {
        let environment = self.environment(pset, input_index, branch, network)?;
        finalize_program(
            self.program(branch),
            witness,
            &environment,
            self.control_block(branch)?,
        )
    }
}

#[derive(Debug)]
pub struct CompiledUser {
    program: CompiledProgram,
    spend_info: TaprootSpendInfo,
}

impl CompiledUser {
    #[must_use]
    pub fn script_pubkey(&self) -> Script {
        Script::new_v1_p2tr_tweaked(self.spend_info.output_key())
    }

    fn control_block(&self) -> anyhow::Result<ControlBlock> {
        let script = Script::from(self.program.commit().cmr().as_ref().to_vec());
        self.spend_info
            .control_block(&(script, leaf_version()))
            .ok_or_else(|| anyhow::anyhow!("missing holder covenant control block"))
    }

    pub fn environment(
        &self,
        pset: &PartiallySignedTransaction,
        input_index: usize,
        network: DeploymentNetwork,
    ) -> anyhow::Result<ElementsEnv<Arc<Transaction>>> {
        build_environment(
            pset,
            input_index,
            self.program.commit().cmr(),
            self.control_block()?,
            &self.script_pubkey(),
            network,
        )
    }

    fn finalize(
        &self,
        pset: &PartiallySignedTransaction,
        witness: &WitnessValues,
        input_index: usize,
        network: DeploymentNetwork,
    ) -> anyhow::Result<Vec<Vec<u8>>> {
        let environment = self.environment(pset, input_index, network)?;
        finalize_program(&self.program, witness, &environment, self.control_block()?)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Protocol {
    config: ProtocolConfig,
    user_executable_leaf_hash: [u8; 32],
}

impl Protocol {
    pub fn new(config: ProtocolConfig) -> anyhow::Result<Self> {
        anyhow::ensure!(
            config.regulated_asset != config.verifier_asset,
            "regulated and verifier assets must be distinct"
        );
        anyhow::ensure!(
            config.verifier_asset_amount == 1,
            "v0.1 requires one verifier unit"
        );
        let user = compile(USER_SOURCE, user_arguments(config))?;
        Ok(Self {
            config,
            user_executable_leaf_hash: leaf_hash(user.commit().cmr()).to_byte_array(),
        })
    }

    #[must_use]
    pub const fn config(&self) -> ProtocolConfig {
        self.config
    }

    #[must_use]
    pub const fn address_params(&self) -> &'static AddressParams {
        address_params(self.config.network)
    }

    #[must_use]
    pub const fn user_executable_leaf_hash(&self) -> [u8; 32] {
        self.user_executable_leaf_hash
    }

    pub fn user_program(&self, owner: XOnlyPublicKey) -> anyhow::Result<CompiledUser> {
        let program = compile(USER_SOURCE, user_arguments(self.config))?;
        let executable = Script::from(program.commit().cmr().as_ref().to_vec());
        let spend_info = TaprootBuilder::new()
            .add_leaf_with_ver(1, executable, leaf_version())
            .map_err(anyhow::Error::msg)?
            .add_hidden(1, tapdata_hash(&owner.serialize()))
            .map_err(anyhow::Error::msg)?
            .finalize(secp256k1::SECP256K1, unspendable_key())
            .map_err(anyhow::Error::msg)?;
        Ok(CompiledUser {
            program,
            spend_info,
        })
    }

    pub fn user_script(&self, owner: XOnlyPublicKey) -> anyhow::Result<Script> {
        Ok(self.user_program(owner)?.script_pubkey())
    }

    pub fn anchor(&self, policy: SetCommitment) -> anyhow::Result<CompiledAnchor> {
        let verifier_source = match policy.depth {
            TreeDepth::D4 => VERIFIER_D4_SOURCE,
            TreeDepth::D5 => VERIFIER_D5_SOURCE,
            TreeDepth::D6 => VERIFIER_D6_SOURCE,
        };
        let verifier = compile(verifier_source, verifier_arguments(self, policy))?;
        let governance = compile(GOVERNANCE_SOURCE, governance_arguments(self.config))?;
        let spend_info = TaprootBuilder::new()
            .add_leaf_with_ver(
                1,
                Script::from(verifier.commit().cmr().as_ref().to_vec()),
                leaf_version(),
            )
            .map_err(anyhow::Error::msg)?
            .add_leaf_with_ver(
                1,
                Script::from(governance.commit().cmr().as_ref().to_vec()),
                leaf_version(),
            )
            .map_err(anyhow::Error::msg)?
            .finalize(secp256k1::SECP256K1, unspendable_key())
            .map_err(anyhow::Error::msg)?;
        Ok(CompiledAnchor {
            verifier,
            governance,
            spend_info,
        })
    }

    #[must_use]
    pub fn governance_witness(signature: Signature) -> WitnessValues {
        witness_map([("ISSUER_SIGNATURE", Value::byte_array(signature.serialize()))])
    }

    pub fn transfer_witness(
        policy: SetCommitment,
        owner: XOnlyPublicKey,
        recipients: [Option<XOnlyPublicKey>; MAX_REGULATED_OUTPUTS],
        proofs: &[IndexedInputPolicyProof],
    ) -> anyhow::Result<WitnessValues> {
        anyhow::ensure!(
            proofs.len() <= MAX_REGULATED_INPUTS,
            "at most ten regulated inputs are supported"
        );
        anyhow::ensure!(
            proofs
                .windows(2)
                .all(|pair| pair[0].input_index < pair[1].input_index),
            "policy proof indexes must be strictly increasing"
        );
        let padding = match policy.depth {
            TreeDepth::D4 => budget_padding(D4_BUDGET_PADDING_WORDS),
            TreeDepth::D5 => budget_padding(D5_BUDGET_PADDING_WORDS),
            TreeDepth::D6 => budget_padding(D6_BUDGET_PADDING_WORDS),
        };
        let proof_values = match policy.depth {
            TreeDepth::D4 => proof_slots::<4>(proofs)?,
            TreeDepth::D5 => proof_slots::<5>(proofs)?,
            TreeDepth::D6 => proof_slots::<6>(proofs)?,
        };
        let recipient_values = Value::array(
            recipients.into_iter().map(|key| match key {
                Some(key) => Value::some(value_u256(key.serialize())),
                None => Value::none(ResolvedType::u256()),
            }),
            ResolvedType::option(ResolvedType::u256()),
        );
        Ok(witness_map([
            ("BUDGET_PADDING", padding),
            ("INPUT_POLICY_PROOFS", proof_values),
            ("RECIPIENTS", recipient_values),
            ("TRANSFER_OWNER", value_u256(owner.serialize())),
        ]))
    }

    pub fn finalize_user(
        &self,
        pset: &PartiallySignedTransaction,
        owner: XOnlyPublicKey,
        signature: Signature,
        input_index: usize,
    ) -> anyhow::Result<Vec<Vec<u8>>> {
        let user = self.user_program(owner)?;
        let witness = witness_map([
            ("OWNER_PUBKEY", value_u256(owner.serialize())),
            ("OWNER_SIGNATURE", Value::byte_array(signature.serialize())),
        ]);
        user.finalize(pset, &witness, input_index, self.config.network)
    }
}

fn build_environment(
    pset: &PartiallySignedTransaction,
    input_index: usize,
    cmr: Cmr,
    control_block: ControlBlock,
    expected_script: &Script,
    network: DeploymentNetwork,
) -> anyhow::Result<ElementsEnv<Arc<Transaction>>> {
    let utxos = pset
        .inputs()
        .iter()
        .map(|input| {
            input
                .witness_utxo
                .clone()
                .ok_or_else(|| anyhow::anyhow!("every PSET input needs a witness UTXO"))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let target = utxos
        .get(input_index)
        .ok_or_else(|| anyhow::anyhow!("AMP input index is out of range"))?;
    anyhow::ensure!(
        target.script_pubkey == *expected_script,
        "AMP input script does not commit the selected program"
    );
    Ok(ElementsEnv::new(
        Arc::new(pset.extract_tx()?),
        utxos
            .into_iter()
            .map(|utxo| ElementsUtxo {
                script_pubkey: utxo.script_pubkey,
                asset: utxo.asset,
                value: utxo.value,
            })
            .collect(),
        u32::try_from(input_index)?,
        cmr,
        control_block,
        None,
        genesis_block_hash(network),
    ))
}

fn finalize_program(
    program: &CompiledProgram,
    witness: &WitnessValues,
    environment: &ElementsEnv<Arc<Transaction>>,
    control_block: ControlBlock,
) -> anyhow::Result<Vec<Vec<u8>>> {
    let satisfied = program
        .satisfy(witness.clone())
        .map_err(anyhow::Error::msg)?;
    let mut tracker = DefaultTracker::build(satisfied.debug_symbols(), Box::new(ElementsJetHinter));
    let pruned: Arc<RedeemNode> = satisfied
        .redeem()
        .prune_with_tracker(environment, &mut tracker)?;
    let mut machine = BitMachine::for_program(&pruned)?;
    machine.exec(&pruned, environment)?;
    let (program_bytes, witness_bytes) = pruned.to_vec_with_witness();
    let stack = vec![
        witness_bytes,
        program_bytes,
        pruned.cmr().as_ref().to_vec(),
        control_block.serialize(),
    ];
    anyhow::ensure!(
        pruned.bounds().cost.is_budget_valid(&stack),
        "Simplicity execution exceeds its deterministic witness budget"
    );
    Ok(stack)
}

fn compile(source: &'static str, arguments: Arguments) -> anyhow::Result<CompiledProgram> {
    TemplateProgram::new_with_unstable(
        source,
        &UnstableFeatures::all(),
        Box::new(ElementsJetHinter),
    )
    .map_err(|error| anyhow::anyhow!(error.to_string()))?
    .instantiate(arguments, false)
    .map_err(anyhow::Error::msg)
}

fn user_arguments(config: ProtocolConfig) -> Arguments {
    argument_map([
        (
            "REGULATED_ASSET_ID",
            value_u256(config.regulated_asset.into_inner().0),
        ),
        (
            "VERIFIER_ASSET_AMOUNT",
            Value::from(UIntValue::U64(config.verifier_asset_amount)),
        ),
        (
            "VERIFIER_ASSET_ID",
            value_u256(config.verifier_asset.into_inner().0),
        ),
    ])
}

fn governance_arguments(config: ProtocolConfig) -> Arguments {
    argument_map([
        ("ISSUER_PUBKEY", value_u256(config.issuer.serialize())),
        (
            "REGULATED_ASSET_ID",
            value_u256(config.regulated_asset.into_inner().0),
        ),
        (
            "VERIFIER_ASSET_AMOUNT",
            Value::from(UIntValue::U64(config.verifier_asset_amount)),
        ),
        (
            "VERIFIER_ASSET_ID",
            value_u256(config.verifier_asset.into_inner().0),
        ),
    ])
}

fn verifier_arguments(protocol: &Protocol, policy: SetCommitment) -> Arguments {
    argument_map([
        ("BLACKLIST_COUNT", Value::from(UIntValue::U32(policy.count))),
        ("BLACKLIST_ROOT", value_u256(policy.root)),
        (
            "REGULATED_ASSET_ID",
            value_u256(protocol.config.regulated_asset.into_inner().0),
        ),
        (
            "USER_EXECUTABLE_LEAF_HASH",
            value_u256(protocol.user_executable_leaf_hash),
        ),
        (
            "VERIFIER_ASSET_AMOUNT",
            Value::from(UIntValue::U64(protocol.config.verifier_asset_amount)),
        ),
        (
            "VERIFIER_ASSET_ID",
            value_u256(protocol.config.verifier_asset.into_inner().0),
        ),
    ])
}

fn proof_slots<const D: usize>(proofs: &[IndexedInputPolicyProof]) -> anyhow::Result<Value> {
    let indexed_type = indexed_proof_type(D);
    let mut values = Vec::with_capacity(MAX_REGULATED_INPUTS);
    for proof in proofs {
        values.push(Value::some(Value::tuple([
            Value::from(UIntValue::U32(proof.input_index)),
            proof_value::<D>(&proof.proof)?,
        ])));
    }
    values.extend((proofs.len()..MAX_REGULATED_INPUTS).map(|_| Value::none(indexed_type.clone())));
    Ok(Value::array(values, ResolvedType::option(indexed_type)))
}

fn proof_value<const D: usize>(
    proof: &amp_core::policy::NonMembershipProof,
) -> anyhow::Result<Value> {
    Ok(Value::tuple([
        Value::from(UIntValue::U32(proof.insertion_index)),
        neighbor_option::<D>(proof.lower.as_ref())?,
        neighbor_option::<D>(proof.upper.as_ref())?,
    ]))
}

fn neighbor_option<const D: usize>(proof: Option<&NeighborProof>) -> anyhow::Result<Value> {
    Ok(match proof {
        Some(proof) => Value::some(neighbor_value::<D>(proof)?),
        None => Value::none(neighbor_type(D)),
    })
}

fn neighbor_value<const D: usize>(proof: &NeighborProof) -> anyhow::Result<Value> {
    anyhow::ensure!(
        proof.path.len() == D,
        "proof path length does not match depth {D}"
    );
    Ok(Value::tuple([
        Value::from(UIntValue::U32(proof.index)),
        value_u256(proof.key),
        Value::array(
            proof.path.iter().copied().map(value_u256),
            ResolvedType::u256(),
        ),
    ]))
}

fn neighbor_type(depth: usize) -> ResolvedType {
    ResolvedType::tuple([
        ResolvedType::u32(),
        ResolvedType::u256(),
        ResolvedType::array(ResolvedType::u256(), depth),
    ])
}

fn indexed_proof_type(depth: usize) -> ResolvedType {
    let neighbor = neighbor_type(depth);
    ResolvedType::tuple([
        ResolvedType::u32(),
        ResolvedType::tuple([
            ResolvedType::u32(),
            ResolvedType::option(neighbor.clone()),
            ResolvedType::option(neighbor),
        ]),
    ])
}

fn budget_padding(words: usize) -> Value {
    Value::array(
        (0..words).map(|_| value_u256([0; 32])),
        ResolvedType::u256(),
    )
}

fn value_u256(bytes: Hash32) -> Value {
    Value::from(UIntValue::U256(U256::from_byte_array(bytes)))
}

fn argument_map<const N: usize>(entries: [(&'static str, Value); N]) -> Arguments {
    Arguments::from(named_values(entries))
}

fn witness_map<const N: usize>(entries: [(&'static str, Value); N]) -> WitnessValues {
    WitnessValues::from(named_values(entries))
}

fn named_values<const N: usize>(
    entries: [(&'static str, Value); N],
) -> HashMap<WitnessName, Value> {
    entries
        .into_iter()
        .map(|(name, value)| (WitnessName::from_str_unchecked(name), value))
        .collect()
}

fn leaf_hash(cmr: Cmr) -> TapLeafHash {
    TapLeafHash::from_script(&Script::from(cmr.as_ref().to_vec()), leaf_version())
}

fn tapdata_hash(data: &[u8]) -> sha256::Hash {
    let tag = sha256::Hash::hash(b"TapData");
    let mut engine = sha256::Hash::engine();
    engine.input(tag.as_byte_array());
    engine.input(tag.as_byte_array());
    engine.input(data);
    sha256::Hash::from_engine(engine)
}

fn unspendable_key() -> XOnlyPublicKey {
    XOnlyPublicKey::from_slice(&[
        0x50, 0x92, 0x9b, 0x74, 0xc1, 0xa0, 0x49, 0x54, 0xb7, 0x8b, 0x4b, 0x60, 0x35, 0xe9, 0x7a,
        0x5e, 0x07, 0x8a, 0x5a, 0x0f, 0x28, 0xec, 0x96, 0xd5, 0x47, 0xbf, 0xee, 0x9a, 0xce, 0x80,
        0x3a, 0xc0,
    ])
    .expect("static NUMS key is valid")
}

const fn address_params(network: DeploymentNetwork) -> &'static AddressParams {
    match network {
        DeploymentNetwork::LiquidTestnet => &AddressParams::LIQUID_TESTNET,
        DeploymentNetwork::ElementsRegtest => &AddressParams::ELEMENTS,
    }
}

fn genesis_block_hash(network: DeploymentNetwork) -> BlockHash {
    let bytes = match network {
        DeploymentNetwork::LiquidTestnet => [
            0xc1, 0xb1, 0x6a, 0xe2, 0x4f, 0x24, 0x23, 0xae, 0xa2, 0xea, 0x34, 0x55, 0x22, 0x92,
            0x79, 0x3b, 0x5b, 0x5e, 0x82, 0x99, 0x9a, 0x1e, 0xed, 0x81, 0xd5, 0x6a, 0xee, 0x52,
            0x8e, 0xda, 0x71, 0xa7,
        ],
        DeploymentNetwork::ElementsRegtest => [
            0x21, 0xca, 0xb1, 0xe5, 0xda, 0x47, 0x18, 0xea, 0x14, 0x0d, 0x97, 0x16, 0x93, 0x17,
            0x02, 0x42, 0x2f, 0x0e, 0x6a, 0xd9, 0x15, 0xc8, 0xd9, 0xb5, 0x83, 0xca, 0xc2, 0x70,
            0x6b, 0x2a, 0x90, 0x00,
        ],
    };
    BlockHash::from_byte_array(bytes)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use amp_core::policy::PolicySet;
    use elements::secp256k1_zkp::{Keypair, SecretKey};

    use super::*;

    #[test]
    fn lightweight_compiler_matches_canonical_contract_hashes() -> anyhow::Result<()> {
        let issuer =
            Keypair::from_secret_key(secp256k1::SECP256K1, &SecretKey::from_slice(&[1; 32])?);
        let protocol = Protocol::new(ProtocolConfig {
            regulated_asset: AssetId::from_str(&"11".repeat(32))?,
            verifier_asset: AssetId::from_str(&"22".repeat(32))?,
            verifier_asset_amount: 1,
            issuer: issuer.x_only_public_key().0,
            network: DeploymentNetwork::ElementsRegtest,
        })?;
        assert_eq!(
            hex::encode(protocol.user_executable_leaf_hash()),
            "5c37ed5a5eefb6ab6f36a66a9f0cac899442464206dce885c621988ba3c03652"
        );
        let expected = [
            (
                TreeDepth::D4,
                "87c94f056f859ef26f8b08b2b82bca13ad604c7a75cea90364d8ccd24a7395e5",
                "512091967acb47fe20abf2fa57a93312827bf0e5133fe773db51fb74cc61860d6334",
            ),
            (
                TreeDepth::D5,
                "f1b319ab406a62a64a37578d147d47bf5d8927251f7dd879e3c91e23594f288f",
                "51200eec020c76a9dfefc87c4696029ab6c34a14eea5c71bfcbd6c32428fe05d72b1",
            ),
            (
                TreeDepth::D6,
                "3575097bdcd837d6a5dc6f38ef12d964bf41ad7af65db63da5128380dc32a059",
                "512099d2b306030df24388e6d3dea471f609255f62269de82dd373b60c76b370e731",
            ),
        ];
        for (depth, verifier_hash, script) in expected {
            let anchor = protocol.anchor(PolicySet::new(depth, [])?.commitment())?;
            assert_eq!(hex::encode(anchor.verifier_program_hash()), verifier_hash);
            assert_eq!(
                hex::encode(anchor.governance_program_hash()),
                "e764e37b3a78d2b48df10adc2b9a46793831893bcc97bdf6360b6454f0056489"
            );
            assert_eq!(hex::encode(anchor.script_pubkey().as_bytes()), script);
        }
        Ok(())
    }
}
