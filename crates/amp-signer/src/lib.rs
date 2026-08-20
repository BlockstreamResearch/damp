//! Standalone AMP signer SDK. LWK owns wallet key, SLIP77 and standard signing primitives;
//! this crate owns AMP policy validation, covenant compilation and high-level operations.

mod blinding;
mod bootstrap;
mod keys;
mod model;
mod policy;
mod policy_update;
mod protocol;
mod receive;
mod reissuance;
mod transaction;
mod transfer;

const CONTRACT_BUNDLE_HASH: &str =
    "fb5ad11d67c46fce7c9c0a20f4fca2fe550387e7b92b5527402b38e1ce85bb3f";

use amp_core::policy::{PolicySet, TreeDepth, outpoint_key};
use amp_core::registry::{
    BlacklistEntryV1, DeploymentManifestV1, PolicySnapshotV1, ReceiveRecordV1,
};
use lwk_signer::SwSigner;
use serde::Serialize;
use wasm_bindgen::prelude::*;

pub use model::*;

#[wasm_bindgen]
pub struct AmpSigner {
    inner: SwSigner,
    network: SignerNetwork,
}

#[wasm_bindgen]
impl AmpSigner {
    #[wasm_bindgen(constructor)]
    pub fn new(mnemonic: &str, network: JsValue) -> Result<AmpSigner, JsError> {
        let network: SignerNetwork = serde_wasm_bindgen::from_value(network)?;
        let inner = SwSigner::new(mnemonic, network.is_mainnet()).map_err(js_error)?;
        Ok(Self { inner, network })
    }

    #[wasm_bindgen(js_name = info)]
    pub fn info_js(&self) -> Result<JsValue, JsError> {
        to_js_value(&SignerInfo {
            sdk: SIGNER_SDK_VERSION,
            fingerprint: self.inner.fingerprint().to_string(),
            descriptor: keys::signer_descriptor(&self.inner).map_err(js_error)?,
            network: self.network,
        })
    }

    #[wasm_bindgen(js_name = deriveAmpKey)]
    pub fn derive_amp_key(&self, deployment_salt: &str, role: &str) -> Result<JsValue, JsError> {
        let index = keys::derive_key_index(deployment_salt, role).map_err(js_error)?;
        let (path, xprv) = keys::derive_xprv(&self.inner, role, index).map_err(js_error)?;
        to_js_value(&DerivedAmpKey {
            sdk: SIGNER_SDK_VERSION,
            derivation_index: index,
            derivation_path: path.to_string(),
            public_key: keys::xonly_from_xprv(&xprv).to_string(),
            role: role.to_owned(),
        })
    }

    #[wasm_bindgen(js_name = deriveWalletAddress)]
    pub fn derive_wallet_address_js(&self, branch: u32, index: u32) -> Result<JsValue, JsError> {
        to_js_value(
            &keys::derive_wallet_address(&self.inner, self.network, branch, index)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name = inspectUtxos)]
    pub fn inspect_utxos_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let utxos: Vec<SpendableUtxo> = serde_wasm_bindgen::from_value(value)?;
        to_js_value(&transaction::inspect_utxos(&self.inner, &utxos).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = createReceiveRecord)]
    pub fn create_receive_record_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let request: CreateReceiveRecordRequest = serde_wasm_bindgen::from_value(value)?;
        to_js_value(
            &receive::create_receive_record(&self.inner, self.network, request)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name = validateReceiveRecord)]
    pub fn validate_receive_record_js(&self, value: JsValue) -> Result<(), JsError> {
        let request: ValidateReceiveRecordRequest = serde_wasm_bindgen::from_value(value)?;
        receive::validate_receive_record(self.network, request).map_err(js_error)
    }

    #[wasm_bindgen(js_name = signTransfer)]
    pub fn sign_transfer_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let request: TransferRequest = serde_wasm_bindgen::from_value(value)?;
        to_js_value(&transfer::sign_transfer(&self.inner, self.network, request).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = signPolicyUpdate)]
    pub fn sign_policy_update_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let request: PolicyUpdateRequest = serde_wasm_bindgen::from_value(value)?;
        to_js_value(
            &policy_update::sign_policy_update(&self.inner, self.network, request)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name = bootstrap)]
    pub fn bootstrap_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let request: BootstrapRequest = serde_wasm_bindgen::from_value(value)?;
        to_js_value(&bootstrap::bootstrap(&self.inner, self.network, request).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = reissue)]
    pub fn reissue_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let request: ReissuanceRequest = serde_wasm_bindgen::from_value(value)?;
        to_js_value(&reissuance::reissue(&self.inner, self.network, request).map_err(js_error)?)
    }
}

#[wasm_bindgen(js_name = preparePolicy)]
pub fn prepare_policy_js(value: JsValue) -> Result<JsValue, JsError> {
    let request: PreparePolicyRequest = serde_wasm_bindgen::from_value(value)?;
    to_js_value(&policy::prepare_policy(request).map_err(js_error)?)
}

#[wasm_bindgen(js_name = validateDeployment)]
pub fn validate_deployment(value: JsValue) -> Result<String, JsError> {
    let manifest: DeploymentManifestV1 = serde_wasm_bindgen::from_value(value)?;
    manifest.validate().map_err(js_error)
}

#[wasm_bindgen(js_name = validatePolicySnapshot)]
pub fn validate_policy_snapshot(value: JsValue) -> Result<JsValue, JsError> {
    let snapshot: PolicySnapshotV1 = serde_wasm_bindgen::from_value(value)?;
    let tree = snapshot.validate().map_err(js_error)?;
    to_js_value(&tree.commitment())
}

#[wasm_bindgen(js_name = validateReceiveRecordShape)]
pub fn validate_receive_record_shape(value: JsValue) -> Result<JsValue, JsError> {
    let record: ReceiveRecordV1 = serde_wasm_bindgen::from_value(value)?;
    record.validate_shape().map_err(js_error)?;
    to_js_value(&record.signing_message())
}

#[wasm_bindgen(js_name = buildBlacklist)]
pub fn build_blacklist(value: JsValue, depth: u8) -> Result<JsValue, JsError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Built {
        tree_depth: TreeDepth,
        policy_root: String,
        set_root: String,
        entry_count: u32,
        entries: Vec<BlacklistEntryV1>,
    }
    let depth = TreeDepth::try_from(depth).map_err(js_error)?;
    let mut entries: Vec<BlacklistEntryV1> = serde_wasm_bindgen::from_value(value)?;
    entries.sort_by(|a, b| (&a.txid, a.vout).cmp(&(&b.txid, b.vout)));
    let keys = entries
        .iter()
        .map(BlacklistEntryV1::key)
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(js_error)?;
    let tree = PolicySet::new(depth, keys).map_err(js_error)?;
    let commitment = tree.commitment();
    to_js_value(&Built {
        tree_depth: depth,
        policy_root: hex::encode(commitment.policy_digest()),
        set_root: hex::encode(commitment.root),
        entry_count: commitment.count,
        entries,
    })
}

#[wasm_bindgen(js_name = proveBlacklistNonMembership)]
pub fn prove_blacklist_non_membership(
    entries: JsValue,
    depth: u8,
    txid: &str,
    vout: u32,
) -> Result<JsValue, JsError> {
    let depth = TreeDepth::try_from(depth).map_err(js_error)?;
    let entries: Vec<BlacklistEntryV1> = serde_wasm_bindgen::from_value(entries)?;
    let keys = entries
        .iter()
        .map(BlacklistEntryV1::key)
        .collect::<anyhow::Result<Vec<_>>>()
        .map_err(js_error)?;
    let tree = PolicySet::new(depth, keys).map_err(js_error)?;
    to_js_value(
        &tree
            .non_membership_proof(outpoint_key(txid, vout).map_err(js_error)?)
            .map_err(js_error)?,
    )
}

#[wasm_bindgen(js_name = deriveKeyIndex)]
pub fn derive_key_index(deployment_salt: &str, role: &str) -> Result<u32, JsError> {
    keys::derive_key_index(deployment_salt, role).map_err(js_error)
}

#[wasm_bindgen(js_name = generateMnemonic)]
pub fn generate_mnemonic() -> Result<String, JsError> {
    let (_, mnemonic) = SwSigner::random(false).map_err(js_error)?;
    Ok(mnemonic.to_string())
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

fn to_js_value(value: &impl Serialize) -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(value).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use amp_core::policy::{PolicySet, TreeDepth};
    use amp_core::registry::{
        AssetMetadata, DeploymentNetwork, PROTOCOL_ID_V1, PolicySnapshotV1, REGISTRY_SCHEMA_V1,
        SupplyMode,
    };
    use elements::confidential::{Asset, Nonce, Value};
    use elements::hashes::Hash as _;
    use elements::{AssetId, Script, TxOut, TxOutWitness, Txid};

    use super::*;

    const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn managed_lifecycle_builds_and_executes_every_operation() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let policy_asset = AssetId::from_str(&"aa".repeat(32))?;
        let funding = [
            funding_utxo(&signer, network, policy_asset, 20_000, 1, 0)?,
            funding_utxo(&signer, network, policy_asset, 20_000, 2, 1)?,
        ];
        let bootstrapped = bootstrap::bootstrap(
            &signer,
            network,
            BootstrapRequest {
                network: DeploymentNetwork::ElementsRegtest,
                policy_asset: policy_asset.to_string(),
                deployment_salt: "11".repeat(32),
                asset: AssetMetadata {
                    name: "AMP Test Asset".to_owned(),
                    ticker: "AMPT".to_owned(),
                    precision: 0,
                },
                issued_supply: "1000".to_owned(),
                supply_mode: SupplyMode::IssuerManaged,
                policy_utxos: funding.to_vec(),
                fee: "500".to_owned(),
                required_confirmations: 1,
                receive_alias: "alice".to_owned(),
            },
        )?;
        bootstrapped.deployment.validate()?;
        bootstrapped.initial_policy.validate()?;
        receive::validate_receive_record(
            network,
            ValidateReceiveRecordRequest {
                deployment: bootstrapped.deployment.clone(),
                record: bootstrapped.initial_receive_record.clone(),
            },
        )?;

        let bootstrap_tx = bootstrapped.transaction.clone();
        let verifier = parent_utxo(&bootstrapped.txid, 0, &bootstrap_tx, None, None);
        let holder = parent_utxo(
            &bootstrapped.txid,
            1,
            &bootstrap_tx,
            None,
            Some(HolderKeyLocator {
                derivation_index: bootstrapped.holder_derivation_index,
                owner_public_key: bootstrapped.initial_receive_record.owner_public_key.clone(),
            }),
        );
        let token = parent_utxo(
            &bootstrapped.txid,
            3,
            &bootstrap_tx,
            Some(WalletKeyLocator {
                branch: 0,
                index: 0,
            }),
            None,
        );
        let bootstrap_fee_change = parent_utxo(
            &bootstrapped.txid,
            4,
            &bootstrap_tx,
            Some(WalletKeyLocator {
                branch: 0,
                index: 0,
            }),
            None,
        );
        let transfer = transfer::sign_transfer(
            &signer,
            network,
            TransferRequest {
                deployment: bootstrapped.deployment.clone(),
                current_policy: bootstrapped.initial_policy.clone(),
                verifier_utxo: verifier,
                regulated_utxos: vec![holder],
                fee_utxos: vec![bootstrap_fee_change],
                recipient: bootstrapped.initial_receive_record.clone(),
                amount: "600".to_owned(),
                fee: "500".to_owned(),
            },
        )?;
        assert_eq!(transfer.operation, "transfer");
        let transfer_anchor = parent_utxo(&transfer.txid, 0, &transfer.transaction, None, None);
        let transfer_fee_change = parent_utxo(
            &transfer.txid,
            3,
            &transfer.transaction,
            Some(WalletKeyLocator {
                branch: 0,
                index: 0,
            }),
            None,
        );

        let successor_set = PolicySet::new(TreeDepth::D5, [])?;
        let successor_commitment = successor_set.commitment();
        let prepared = policy::prepare_policy(PreparePolicyRequest {
            deployment: bootstrapped.deployment.clone(),
            tree_depth: TreeDepth::D5,
            set_root: hex::encode(successor_commitment.root),
            entry_count: 0,
        })?;
        let successor = PolicySnapshotV1 {
            schema: REGISTRY_SCHEMA_V1.to_owned(),
            protocol: PROTOCOL_ID_V1.to_owned(),
            deployment_id: bootstrapped.deployment_id.clone(),
            sequence: 1,
            parent_policy_root: Some(bootstrapped.initial_policy.policy_root.clone()),
            parent_verifier_script_hash: Some(bootstrapped.initial_policy.verifier_script_hash()?),
            tree_depth: TreeDepth::D5,
            set_root: hex::encode(successor_commitment.root),
            entry_count: 0,
            policy_root: prepared.policy_root,
            verifier_program_hash: prepared.verifier_program_hash,
            verifier_script_pubkey: prepared.verifier_script_pubkey,
            entries: Vec::new(),
        };
        successor.validate()?;
        let policy_update = policy_update::sign_policy_update(
            &signer,
            network,
            PolicyUpdateRequest {
                deployment: bootstrapped.deployment.clone(),
                current_policy: bootstrapped.initial_policy.clone(),
                successor_policy: successor.clone(),
                verifier_utxo: transfer_anchor,
                fee_utxos: vec![transfer_fee_change],
                fee: "500".to_owned(),
                issuer_derivation_index: bootstrapped.issuer_derivation_index,
            },
        )?;
        assert_eq!(policy_update.review.successor_depth, Some(TreeDepth::D5));

        let update_anchor = parent_utxo(
            &policy_update.txid,
            0,
            &policy_update.transaction,
            None,
            None,
        );
        let update_fee_change = parent_utxo(
            &policy_update.txid,
            1,
            &policy_update.transaction,
            Some(WalletKeyLocator {
                branch: 0,
                index: 0,
            }),
            None,
        );
        let reissued = reissuance::reissue(
            &signer,
            network,
            ReissuanceRequest {
                deployment: bootstrapped.deployment,
                current_policy: successor,
                verifier_utxo: update_anchor,
                token_utxo: token,
                fee_utxos: vec![update_fee_change],
                recipient: bootstrapped.initial_receive_record,
                amount: "100".to_owned(),
                fee: "500".to_owned(),
                issuer_derivation_index: bootstrapped.issuer_derivation_index,
            },
        )?;
        assert_eq!(reissued.operation, "reissuance");
        Ok(())
    }

    #[test]
    fn pending_wallet_output_can_be_inspected_but_not_spent() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let asset = AssetId::from_str(&"aa".repeat(32))?;
        let mut pending = funding_utxo(&signer, network, asset, 5_000, 9, 0)?;
        pending.spendable = false;

        let inspected = transaction::inspect_utxos(&signer, &[pending.clone()])?;
        assert_eq!(inspected[0].amount, "5000");
        assert_eq!(inspected[0].asset_id, asset.to_string());
        assert!(transaction::decode_utxo(&signer, &pending, asset).is_err());
        Ok(())
    }

    fn funding_utxo(
        signer: &SwSigner,
        network: SignerNetwork,
        asset: AssetId,
        value: u64,
        txid_byte: u8,
        index: u32,
    ) -> anyhow::Result<SpendableUtxo> {
        let address = keys::derive_wallet_address(signer, network, 0, index)?;
        let script = Script::from(hex::decode(address.script_pubkey)?);
        let txout = TxOut {
            asset: Asset::Explicit(asset),
            value: Value::Explicit(value),
            nonce: Nonce::Null,
            script_pubkey: script,
            witness: TxOutWitness::default(),
        };
        Ok(SpendableUtxo {
            txid: Txid::from_byte_array([txid_byte; 32]).to_string(),
            vout: 0,
            tx_out: Some(hex::encode(elements::encode::serialize(&txout))),
            transaction: None,
            spendable: true,
            wallet_key: Some(WalletKeyLocator { branch: 0, index }),
            holder_key: None,
        })
    }

    fn parent_utxo(
        txid: &str,
        vout: u32,
        transaction: &str,
        wallet_key: Option<WalletKeyLocator>,
        holder_key: Option<HolderKeyLocator>,
    ) -> SpendableUtxo {
        SpendableUtxo {
            txid: txid.to_owned(),
            vout,
            tx_out: None,
            transaction: Some(transaction.to_owned()),
            spendable: true,
            wallet_key,
            holder_key,
        }
    }
}
