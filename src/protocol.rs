//! Compilation and Taproot construction for blacklist-only AMP covenants.

use std::sync::Arc;

use crate::artifacts::governance::GovernanceProgram;
use crate::artifacts::governance::derived_governance::{GovernanceArguments, GovernanceWitness};
use crate::artifacts::user::UserProgram;
use crate::artifacts::user::derived_user::{UserArguments, UserWitness};
use crate::artifacts::verifier::VerifierProgram;
use crate::artifacts::verifier::derived_verifier::{VerifierArguments, VerifierWitness};
use crate::artifacts::verifier_d5::VerifierD5Program;
use crate::artifacts::verifier_d5::derived_verifier_d5::{VerifierD5Arguments, VerifierD5Witness};
use crate::artifacts::verifier_d6::VerifierD6Program;
use crate::artifacts::verifier_d6::derived_verifier_d6::{VerifierD6Arguments, VerifierD6Witness};
use crate::policy::{Hash32, IndexedInputPolicyProof, NeighborProof, SetCommitment, TreeDepth};

use simplex::global::GlobalConfig;
use simplex::program::{ArgumentsTrait, ProgramTrait, WitnessTrait};
use simplex::provider::SimplicityNetwork;
use simplex::simplicityhl::ast::ElementsJetHinter;
use simplex::simplicityhl::elements::hashes::Hash;
use simplex::simplicityhl::elements::pset::PartiallySignedTransaction;
use simplex::simplicityhl::elements::schnorr::XOnlyPublicKey;
use simplex::simplicityhl::elements::secp256k1_zkp::{self as secp256k1, schnorr::Signature};
use simplex::simplicityhl::elements::taproot::{
    ControlBlock, TapLeafHash, TaprootBuilder, TaprootSpendInfo,
};
use simplex::simplicityhl::elements::{AssetId, Script, Transaction};
use simplex::simplicityhl::simplicity::jet::elements::{ElementsEnv, ElementsUtxo};
use simplex::simplicityhl::simplicity::{BitMachine, Cmr, RedeemNode, leaf_version};
use simplex::simplicityhl::tracker::DefaultTracker;
use simplex::simplicityhl::{CompiledProgram, TemplateProgram, UnstableFeatures, WitnessValues};
use simplex::utils::tr_unspendable_key;

pub const MAX_REGULATED_INPUTS: usize = 10;
pub const MAX_REGULATED_OUTPUTS: usize = 10;
pub const D4_BUDGET_PADDING_WORDS: usize = 278;
pub const D5_BUDGET_PADDING_WORDS: usize = 329;
pub const D6_BUDGET_PADDING_WORDS: usize = 380;

type NeighborWitness<const D: usize> = (u32, Hash32, [Hash32; D]);
type ProofWitness<const D: usize> = (u32, Option<NeighborWitness<D>>, Option<NeighborWitness<D>>);
type IndexedProofWitness<const D: usize> = (u32, ProofWitness<D>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolConfig {
    pub regulated_asset: AssetId,
    pub verifier_asset: AssetId,
    pub verifier_asset_amount: u64,
    pub issuer: XOnlyPublicKey,
    pub network: SimplicityNetwork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorBranch {
    Verifier,
    Governance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionMetrics {
    /// Consensus execution cost in milli-weight units.
    pub execution_milliweight: u32,
    /// Consensus-encoded bytes in the four-item Simplicity witness stack.
    pub witness_bytes: usize,
    /// Additional annex bytes that would be required. Standard finalization requires zero.
    pub required_padding_bytes: usize,
}

#[derive(Debug)]
pub struct CompiledAnchor {
    depth: TreeDepth,
    verifier: CompiledProgram,
    governance: CompiledProgram,
    spend_info: TaprootSpendInfo,
}

impl CompiledAnchor {
    #[must_use]
    pub const fn depth(&self) -> TreeDepth {
        self.depth
    }

    #[must_use]
    pub const fn verifier_program(&self) -> &CompiledProgram {
        &self.verifier
    }

    #[must_use]
    pub const fn governance_program(&self) -> &CompiledProgram {
        &self.governance
    }

    #[must_use]
    pub fn verifier_cmr(&self) -> Cmr {
        self.verifier.commit().cmr()
    }

    #[must_use]
    pub fn governance_cmr(&self) -> Cmr {
        self.governance.commit().cmr()
    }

    #[must_use]
    pub fn verifier_program_hash(&self) -> [u8; 32] {
        leaf_hash(self.verifier_cmr()).to_byte_array()
    }

    #[must_use]
    pub fn governance_program_hash(&self) -> [u8; 32] {
        leaf_hash(self.governance_cmr()).to_byte_array()
    }

    #[must_use]
    pub fn script_pubkey(&self) -> Script {
        Script::new_v1_p2tr_tweaked(self.spend_info.output_key())
    }

    pub fn control_block(&self, branch: AnchorBranch) -> anyhow::Result<ControlBlock> {
        let cmr = match branch {
            AnchorBranch::Verifier => self.verifier_cmr(),
            AnchorBranch::Governance => self.governance_cmr(),
        };
        self.spend_info
            .control_block(&(Script::from(cmr.as_ref().to_vec()), leaf_version()))
            .ok_or_else(|| anyhow::anyhow!("missing AMP {branch:?} control block"))
    }

    pub fn environment(
        &self,
        pst: &PartiallySignedTransaction,
        input_index: usize,
        branch: AnchorBranch,
        network: &SimplicityNetwork,
    ) -> anyhow::Result<ElementsEnv<Arc<Transaction>>> {
        let witness_utxos = pst
            .inputs()
            .iter()
            .map(|input| {
                input
                    .witness_utxo
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("every PSET input needs a witness UTXO"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let target = witness_utxos
            .get(input_index)
            .ok_or_else(|| anyhow::anyhow!("AMP input index is out of range"))?;
        anyhow::ensure!(
            target.script_pubkey == self.script_pubkey(),
            "AMP input script does not commit the selected two-leaf tree"
        );
        let cmr = match branch {
            AnchorBranch::Verifier => self.verifier_cmr(),
            AnchorBranch::Governance => self.governance_cmr(),
        };
        Ok(ElementsEnv::new(
            Arc::new(pst.extract_tx()?),
            witness_utxos
                .iter()
                .map(|utxo| ElementsUtxo {
                    script_pubkey: utxo.script_pubkey.clone(),
                    asset: utxo.asset,
                    value: utxo.value,
                })
                .collect(),
            u32::try_from(input_index)?,
            cmr,
            self.control_block(branch)?,
            None,
            network.genesis_block_hash(),
        ))
    }

    pub fn execute(
        &self,
        pst: &PartiallySignedTransaction,
        witness: &WitnessValues,
        input_index: usize,
        branch: AnchorBranch,
        network: &SimplicityNetwork,
    ) -> anyhow::Result<()> {
        self.execute_pruned(pst, witness, input_index, branch, network)?;
        Ok(())
    }

    fn execute_pruned(
        &self,
        pst: &PartiallySignedTransaction,
        witness: &WitnessValues,
        input_index: usize,
        branch: AnchorBranch,
        network: &SimplicityNetwork,
    ) -> anyhow::Result<Arc<RedeemNode>> {
        let program = match branch {
            AnchorBranch::Verifier => &self.verifier,
            AnchorBranch::Governance => &self.governance,
        };
        let satisfied = program
            .satisfy(witness.clone())
            .map_err(anyhow::Error::msg)?;
        let environment = self.environment(pst, input_index, branch, network)?;
        let mut tracker =
            DefaultTracker::build(satisfied.debug_symbols(), Box::new(ElementsJetHinter));
        let pruned = satisfied
            .redeem()
            .prune_with_tracker(&environment, &mut tracker)?;
        let mut machine = BitMachine::for_program(&pruned)?;
        machine.exec(&pruned, &environment)?;
        Ok(pruned)
    }

    pub fn finalize(
        &self,
        pst: &PartiallySignedTransaction,
        witness: &WitnessValues,
        input_index: usize,
        branch: AnchorBranch,
        network: &SimplicityNetwork,
    ) -> anyhow::Result<Vec<Vec<u8>>> {
        let pruned = self.execute_pruned(pst, witness, input_index, branch, network)?;
        let (program_bytes, witness_bytes) = pruned.to_vec_with_witness();
        let cmr = pruned.cmr();
        let witness_stack = vec![
            witness_bytes,
            program_bytes,
            cmr.as_ref().to_vec(),
            self.control_block(branch)?.serialize(),
        ];
        let cost = pruned.bounds().cost;
        anyhow::ensure!(
            cost.is_budget_valid(&witness_stack),
            "Simplicity execution exceeds its deterministic in-program budget"
        );
        Ok(witness_stack)
    }

    pub fn execution_metrics(
        &self,
        pst: &PartiallySignedTransaction,
        witness: &WitnessValues,
        input_index: usize,
        branch: AnchorBranch,
        network: &SimplicityNetwork,
    ) -> anyhow::Result<ExecutionMetrics> {
        let pruned = self.execute_pruned(pst, witness, input_index, branch, network)?;
        let cost = pruned.bounds().cost;
        let (program_bytes, witness_data) = pruned.to_vec_with_witness();
        let base_witness_stack = vec![
            witness_data,
            program_bytes,
            pruned.cmr().as_ref().to_vec(),
            self.control_block(branch)?.serialize(),
        ];
        let required_padding_bytes = cost
            .get_padding(&base_witness_stack)
            .map_or(0, |annex| annex.len());
        let witness_bytes =
            simplex::simplicityhl::elements::encode::serialize(&base_witness_stack).len();
        Ok(ExecutionMetrics {
            execution_milliweight: cost.to_string().parse()?,
            witness_bytes,
            required_padding_bytes,
        })
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
        let compiled = compile(UserProgram::SOURCE, Self::user_arguments_for(config))?;
        Ok(Self {
            config,
            user_executable_leaf_hash: leaf_hash(compiled.commit().cmr()).to_byte_array(),
        })
    }

    #[must_use]
    pub const fn config(&self) -> ProtocolConfig {
        self.config
    }

    #[must_use]
    pub const fn user_executable_leaf_hash(&self) -> [u8; 32] {
        self.user_executable_leaf_hash
    }

    #[must_use]
    #[allow(unused_must_use)]
    pub fn user_program(&self, owner: XOnlyPublicKey) -> UserProgram {
        let mut program =
            UserProgram::new(Self::user_arguments_for(self.config)).with_storage_capacity(1);
        program.set_storage_at(0, owner.serialize());
        program
    }

    #[must_use]
    pub fn user_script(&self, owner: XOnlyPublicKey) -> Script {
        self.user_program(owner)
            .get_script_pubkey(&self.config.network)
    }

    pub fn anchor(&self, policy: SetCommitment) -> anyhow::Result<CompiledAnchor> {
        let verifier = match policy.depth {
            TreeDepth::D4 => compile(VerifierProgram::SOURCE, self.verifier_arguments_d4(policy))?,
            TreeDepth::D5 => compile(
                VerifierD5Program::SOURCE,
                self.verifier_arguments_d5(policy),
            )?,
            TreeDepth::D6 => compile(
                VerifierD6Program::SOURCE,
                self.verifier_arguments_d6(policy),
            )?,
        };
        let governance = compile(GovernanceProgram::SOURCE, self.governance_arguments())?;
        let verifier_cmr = verifier.commit().cmr();
        let governance_cmr = governance.commit().cmr();
        let spend_info = TaprootBuilder::new()
            .add_leaf_with_ver(
                1,
                Script::from(verifier_cmr.as_ref().to_vec()),
                leaf_version(),
            )
            .map_err(anyhow::Error::msg)?
            .add_leaf_with_ver(
                1,
                Script::from(governance_cmr.as_ref().to_vec()),
                leaf_version(),
            )
            .map_err(anyhow::Error::msg)?
            .finalize(secp256k1::SECP256K1, tr_unspendable_key())
            .map_err(anyhow::Error::msg)?;
        Ok(CompiledAnchor {
            depth: policy.depth,
            verifier,
            governance,
            spend_info,
        })
    }

    pub fn verifier_script(&self, policy: SetCommitment) -> anyhow::Result<Script> {
        Ok(self.anchor(policy)?.script_pubkey())
    }

    #[must_use]
    pub fn user_witness(owner: XOnlyPublicKey, signature: Signature) -> WitnessValues {
        UserWitness {
            owner_pubkey: owner.serialize(),
            owner_signature: signature.serialize(),
        }
        .build_witness()
    }

    /// Finalize a holder covenant and reject any shape that would require a non-standard annex.
    pub fn finalize_user(
        &self,
        pst: &PartiallySignedTransaction,
        owner: XOnlyPublicKey,
        signature: Signature,
        input_index: usize,
        network: &SimplicityNetwork,
    ) -> anyhow::Result<Vec<Vec<u8>>> {
        let program = self.user_program(owner);
        let witness = Self::user_witness(owner, signature);
        let pruned = program
            .as_ref()
            .execute(pst, &witness, input_index, network)?
            .0;
        let witness_stack = program
            .as_ref()
            .finalize(pst, &witness, input_index, network)?;
        let cost = pruned.bounds().cost;
        anyhow::ensure!(
            cost.is_budget_valid(&witness_stack),
            "holder execution exceeds its deterministic witness budget"
        );
        Ok(witness_stack)
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
        let recipients = recipients.map(|key| key.map(|key| key.serialize()));
        Ok(match policy.depth {
            TreeDepth::D4 => VerifierWitness {
                budget_padding: [[0; 32]; D4_BUDGET_PADDING_WORDS],
                input_policy_proofs: build_proof_slots::<4>(proofs)?,
                recipients,
                transfer_owner: owner.serialize(),
            }
            .build_witness(),
            TreeDepth::D5 => VerifierD5Witness {
                budget_padding: [[0; 32]; D5_BUDGET_PADDING_WORDS],
                input_policy_proofs: build_proof_slots::<5>(proofs)?,
                recipients,
                transfer_owner: owner.serialize(),
            }
            .build_witness(),
            TreeDepth::D6 => VerifierD6Witness {
                budget_padding: [[0; 32]; D6_BUDGET_PADDING_WORDS],
                input_policy_proofs: build_proof_slots::<6>(proofs)?,
                recipients,
                transfer_owner: owner.serialize(),
            }
            .build_witness(),
        })
    }

    #[must_use]
    pub fn governance_witness(signature: Signature) -> WitnessValues {
        GovernanceWitness {
            issuer_signature: signature.serialize(),
        }
        .build_witness()
    }

    fn user_arguments_for(config: ProtocolConfig) -> UserArguments {
        UserArguments {
            regulated_asset_id: config.regulated_asset.into_inner().0,
            verifier_asset_amount: config.verifier_asset_amount,
            verifier_asset_id: config.verifier_asset.into_inner().0,
        }
    }

    fn verifier_arguments_d4(&self, policy: SetCommitment) -> VerifierArguments {
        VerifierArguments {
            blacklist_count: policy.count,
            blacklist_root: policy.root,
            regulated_asset_id: self.config.regulated_asset.into_inner().0,
            user_executable_leaf_hash: self.user_executable_leaf_hash,
            verifier_asset_amount: self.config.verifier_asset_amount,
            verifier_asset_id: self.config.verifier_asset.into_inner().0,
        }
    }

    fn verifier_arguments_d5(&self, policy: SetCommitment) -> VerifierD5Arguments {
        VerifierD5Arguments {
            blacklist_count: policy.count,
            blacklist_root: policy.root,
            regulated_asset_id: self.config.regulated_asset.into_inner().0,
            user_executable_leaf_hash: self.user_executable_leaf_hash,
            verifier_asset_amount: self.config.verifier_asset_amount,
            verifier_asset_id: self.config.verifier_asset.into_inner().0,
        }
    }

    fn verifier_arguments_d6(&self, policy: SetCommitment) -> VerifierD6Arguments {
        VerifierD6Arguments {
            blacklist_count: policy.count,
            blacklist_root: policy.root,
            regulated_asset_id: self.config.regulated_asset.into_inner().0,
            user_executable_leaf_hash: self.user_executable_leaf_hash,
            verifier_asset_amount: self.config.verifier_asset_amount,
            verifier_asset_id: self.config.verifier_asset.into_inner().0,
        }
    }

    fn governance_arguments(&self) -> GovernanceArguments {
        GovernanceArguments {
            issuer_pubkey: self.config.issuer.serialize(),
            regulated_asset_id: self.config.regulated_asset.into_inner().0,
            verifier_asset_amount: self.config.verifier_asset_amount,
            verifier_asset_id: self.config.verifier_asset.into_inner().0,
        }
    }
}

fn build_proof_slots<const D: usize>(
    proofs: &[IndexedInputPolicyProof],
) -> anyhow::Result<[Option<IndexedProofWitness<D>>; MAX_REGULATED_INPUTS]> {
    let mut slots = std::array::from_fn(|_| None);
    for (slot, indexed) in slots.iter_mut().zip(proofs) {
        *slot = Some((indexed.input_index, proof_witness::<D>(&indexed.proof)?));
    }
    Ok(slots)
}

fn proof_witness<const D: usize>(
    proof: &crate::policy::NonMembershipProof,
) -> anyhow::Result<ProofWitness<D>> {
    Ok((
        proof.insertion_index,
        proof
            .lower
            .as_ref()
            .map(neighbor_witness::<D>)
            .transpose()?,
        proof
            .upper
            .as_ref()
            .map(neighbor_witness::<D>)
            .transpose()?,
    ))
}

fn neighbor_witness<const D: usize>(proof: &NeighborProof) -> anyhow::Result<NeighborWitness<D>> {
    Ok((
        proof.index,
        proof.key,
        proof
            .path
            .clone()
            .try_into()
            .map_err(|_| anyhow::anyhow!("proof path length does not match depth {D}"))?,
    ))
}

fn compile(
    source: &'static str,
    arguments: impl ArgumentsTrait,
) -> anyhow::Result<CompiledProgram> {
    TemplateProgram::new_with_unstable(
        source,
        &UnstableFeatures::all(),
        Box::new(ElementsJetHinter),
    )
    .map_err(anyhow::Error::msg)?
    .instantiate(
        arguments.build_arguments(),
        GlobalConfig::get_include_debug_symbols(),
    )
    .map_err(anyhow::Error::msg)
}

fn leaf_hash(cmr: Cmr) -> TapLeafHash {
    TapLeafHash::from_script(&Script::from(cmr.as_ref().to_vec()), leaf_version())
}
