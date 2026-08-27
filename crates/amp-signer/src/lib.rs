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
mod split;
mod transaction;
mod transfer;

const CONTRACT_BUNDLE_HASH: &str =
    "00a50b7658d5914170286b75b95200687b7773c7082c02e3da1dd20012401b74";

use amp_core::policy::{PolicySet, TreeDepth, outpoint_key};
use amp_core::registry::{BlacklistEntryV1, DeploymentManifestV1, PolicySnapshotV1};
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

    #[wasm_bindgen(js_name = deriveHolderAddress)]
    pub fn derive_holder_address_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let deployment: DeploymentManifestV1 = serde_wasm_bindgen::from_value(value)?;
        to_js_value(
            &receive::derive_holder_address(&self.inner, self.network, deployment)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name = validateRecipientAddress)]
    pub fn validate_recipient_address_js(
        &self,
        deployment: JsValue,
        address: &str,
    ) -> Result<String, JsError> {
        let deployment: DeploymentManifestV1 = serde_wasm_bindgen::from_value(deployment)?;
        Ok(
            receive::validate_recipient_address(self.network, &deployment, address)
                .map_err(js_error)?
                .to_string(),
        )
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

    #[wasm_bindgen(js_name = splitFunding)]
    pub fn split_funding_js(&self, value: JsValue) -> Result<JsValue, JsError> {
        let request: SplitFundingRequest = serde_wasm_bindgen::from_value(value)?;
        to_js_value(&split::split_funding(&self.inner, self.network, request).map_err(js_error)?)
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
    // Registry JSON distinguishes an explicit null parent from a missing field.
    // Match serde_json at the WASM boundary instead of turning Option::None into
    // JavaScript undefined, which strict consumers correctly reject.
    value
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use amp_core::policy::{PolicySet, TreeDepth};
    use amp_core::registry::{
        AssetMetadata, DeploymentNetwork, PROTOCOL_ID_V1, PolicySnapshotV1, REGISTRY_SCHEMA_V1,
        SupplyMode,
    };
    use anyhow::Context;
    use elements::confidential::{Asset, AssetBlindingFactor, Nonce, Value, ValueBlindingFactor};
    use elements::hashes::Hash as _;
    use elements::{Address, AssetId, Script, TxOut, TxOutSecrets, TxOutWitness, Txid};

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
            },
        )?;
        bootstrapped.deployment.validate()?;
        bootstrapped.initial_policy.validate()?;
        let regulated_asset = AssetId::from_str(&bootstrapped.deployment.regulated_asset)?;
        let bootstrap_transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(&bootstrapped.transaction)?)?;
        transaction::validate_network_fee(&bootstrap_transaction, 500)?;
        assert!(transaction::validate_network_fee(&bootstrap_transaction, 499).is_err());
        assert_eq!(
            bootstrap_transaction.output[1].asset.explicit(),
            Some(regulated_asset)
        );
        assert_eq!(bootstrap_transaction.output[1].value.explicit(), Some(1000));
        assert_eq!(
            bootstrap_transaction
                .output
                .iter()
                .filter(|output| output.asset.explicit() == Some(regulated_asset))
                .count(),
            1
        );
        receive::validate_recipient_address(
            network,
            &bootstrapped.deployment,
            &bootstrapped.initial_holder_address.confidential_address,
        )?;
        assert!(
            receive::validate_recipient_address(
                network,
                &bootstrapped.deployment,
                "not-an-address",
            )
            .is_err()
        );
        let parsed_holder =
            Address::from_str(&bootstrapped.initial_holder_address.confidential_address)?;
        let unconfidential =
            Address::from_script(&parsed_holder.script_pubkey(), None, parsed_holder.params)
                .ok_or_else(|| anyhow::anyhow!("holder script has no unconfidential address"))?;
        assert!(
            receive::validate_recipient_address(
                network,
                &bootstrapped.deployment,
                &unconfidential.to_string(),
            )
            .is_err()
        );
        let mut incompatible = bootstrapped.deployment.clone();
        incompatible.regulated_asset = "de".repeat(32);
        assert!(
            receive::validate_recipient_address(
                network,
                &incompatible,
                &bootstrapped.initial_holder_address.confidential_address,
            )
            .is_err()
        );
        assert!(
            receive::validate_recipient_address(
                SignerNetwork::LiquidTestnet,
                &bootstrapped.deployment,
                &bootstrapped.initial_holder_address.confidential_address,
            )
            .is_err()
        );

        let bootstrap_tx = bootstrapped.transaction.clone();
        let verifier = parent_utxo(&bootstrapped.txid, 0, &bootstrap_tx, None, None);
        let holder = parent_utxo(
            &bootstrapped.txid,
            1,
            &bootstrap_tx,
            None,
            Some(HolderKeyLocator {
                derivation_index: bootstrapped.holder_derivation_index,
                owner_public_key: bootstrapped.initial_holder_address.owner_public_key.clone(),
            }),
        );
        let token = parent_utxo(
            &bootstrapped.txid,
            2,
            &bootstrap_tx,
            Some(WalletKeyLocator {
                branch: 0,
                index: 0,
            }),
            None,
        );
        let bootstrap_fee_change = parent_utxo(
            &bootstrapped.txid,
            3,
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
                recipient_address: bootstrapped
                    .initial_holder_address
                    .confidential_address
                    .clone(),
                amount: "600".to_owned(),
                fee: "500".to_owned(),
            },
        )?;
        assert_eq!(transfer.operation, "transfer");
        let transfer_transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(&transfer.transaction)?)?;
        assert_eq!(
            transfer_transaction.output[1].asset.explicit(),
            Some(regulated_asset)
        );
        assert_eq!(transfer_transaction.output[1].value.explicit(), Some(600));
        assert_eq!(
            transfer_transaction.output[2].asset.explicit(),
            Some(regulated_asset)
        );
        assert_eq!(transfer_transaction.output[2].value.explicit(), Some(400));
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
                recipient_address: bootstrapped.initial_holder_address.confidential_address,
                amount: "100".to_owned(),
                fee: "500".to_owned(),
                issuer_derivation_index: bootstrapped.issuer_derivation_index,
            },
        )?;
        assert_eq!(reissued.operation, "reissuance");
        let reissuance_transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(&reissued.transaction)?)?;
        assert_eq!(
            reissuance_transaction.output[1].asset.explicit(),
            Some(regulated_asset)
        );
        assert_eq!(reissuance_transaction.output[1].value.explicit(), Some(100));
        assert_eq!(
            reissuance_transaction
                .output
                .iter()
                .filter(|output| output.asset.explicit() == Some(regulated_asset))
                .count(),
            1
        );
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

    #[test]
    fn bootstrap_accepts_confidential_lbtc_and_normalizes_explicit_asset_change()
    -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let policy_asset = AssetId::from_str(&"aa".repeat(32))?;
        let funding = vec![
            confidential_funding_utxo(&signer, network, policy_asset, 100_000, 0)?,
            confidential_funding_utxo(&signer, network, policy_asset, 100_000, 1)?,
        ];
        let decoded_funding = funding
            .iter()
            .map(|utxo| transaction::decode_confidential_wallet_utxo(&signer, utxo, policy_asset))
            .collect::<anyhow::Result<Vec<_>>>()?;
        assert!(decoded_funding.iter().all(|utxo| {
            utxo.secrets.asset_bf != AssetBlindingFactor::zero()
                && utxo.secrets.value_bf != ValueBlindingFactor::zero()
        }));

        let bootstrapped = bootstrap::bootstrap(
            &signer,
            network,
            BootstrapRequest {
                network: DeploymentNetwork::ElementsRegtest,
                policy_asset: policy_asset.to_string(),
                deployment_salt: "22".repeat(32),
                asset: AssetMetadata {
                    name: "Confidential funding test".to_owned(),
                    ticker: "CFT".to_owned(),
                    precision: 0,
                },
                issued_supply: "1000".to_owned(),
                supply_mode: SupplyMode::IssuerManaged,
                policy_utxos: funding.clone(),
                fee: "2000".to_owned(),
                required_confirmations: 1,
            },
        )?;

        let transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(&bootstrapped.transaction)?)?;
        let (serialized_regulated_asset, serialized_token_asset) =
            transaction.input[0].issuance_ids();
        let (serialized_verifier_asset, _) = transaction.input[1].issuance_ids();
        assert_eq!(
            transaction.input[0].asset_issuance.inflation_keys,
            Value::Explicit(1)
        );
        assert_eq!(
            transaction.input[1].asset_issuance.inflation_keys,
            Value::Null
        );
        assert_eq!(
            serialized_regulated_asset.to_string(),
            bootstrapped.deployment.regulated_asset
        );
        assert_eq!(
            serialized_token_asset.to_string(),
            bootstrapped.deployment.reissuance_token.clone().unwrap()
        );
        assert_eq!(
            serialized_verifier_asset.to_string(),
            bootstrapped.deployment.verifier_asset
        );
        let regulated_asset = AssetId::from_str(&bootstrapped.deployment.regulated_asset)?;
        assert_eq!(
            transaction.output[1].asset.explicit(),
            Some(regulated_asset)
        );
        assert_eq!(transaction.output[1].value.explicit(), Some(1000));
        assert_eq!(
            transaction
                .output
                .iter()
                .filter(|output| output.asset.explicit() == Some(regulated_asset))
                .count(),
            1
        );
        let spent_outputs = transaction
            .input
            .iter()
            .map(|input| {
                let utxo = funding
                    .iter()
                    .find(|utxo| {
                        utxo.txid == input.previous_output.txid.to_string()
                            && utxo.vout == input.previous_output.vout
                    })
                    .context("transaction input is not one of the funding UTXOs")?;
                let parent: elements::Transaction = elements::encode::deserialize(&hex::decode(
                    utxo.transaction
                        .as_deref()
                        .context("missing funding transaction")?,
                )?)?;
                parent
                    .output
                    .get(utxo.vout as usize)
                    .cloned()
                    .context("missing funding output")
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        transaction::verify_transaction_amounts(&transaction, &spent_outputs)?;
        let mut change_total = 0u64;
        for (vout, index) in [(3, 0), (4, 1)] {
            let change = transaction
                .output
                .get(vout as usize)
                .context("missing normalized L-BTC change")?;
            assert_eq!(change.asset.explicit(), Some(policy_asset));
            assert!(matches!(change.value, Value::Confidential(_)));

            let decoded = transaction::decode_utxo(
                &signer,
                &SpendableUtxo {
                    txid: bootstrapped.txid.clone(),
                    vout,
                    tx_out: None,
                    transaction: Some(bootstrapped.transaction.clone()),
                    spendable: true,
                    wallet_key: Some(WalletKeyLocator { branch: 1, index }),
                    holder_key: None,
                },
                policy_asset,
            )?;
            change_total += decoded.secrets.value;
            assert_eq!(decoded.secrets.asset_bf, AssetBlindingFactor::zero());
            assert_ne!(decoded.secrets.value_bf, ValueBlindingFactor::zero());
        }
        assert_eq!(change_total, 198_000);

        let transfer = transfer::sign_transfer(
            &signer,
            network,
            TransferRequest {
                deployment: bootstrapped.deployment.clone(),
                current_policy: bootstrapped.initial_policy.clone(),
                verifier_utxo: parent_utxo(
                    &bootstrapped.txid,
                    0,
                    &bootstrapped.transaction,
                    None,
                    None,
                ),
                regulated_utxos: vec![parent_utxo(
                    &bootstrapped.txid,
                    1,
                    &bootstrapped.transaction,
                    None,
                    Some(HolderKeyLocator {
                        derivation_index: bootstrapped.holder_derivation_index,
                        owner_public_key: bootstrapped
                            .initial_holder_address
                            .owner_public_key
                            .clone(),
                    }),
                )],
                fee_utxos: vec![parent_utxo(
                    &bootstrapped.txid,
                    3,
                    &bootstrapped.transaction,
                    Some(WalletKeyLocator {
                        branch: 1,
                        index: 0,
                    }),
                    None,
                )],
                recipient_address: bootstrapped.initial_holder_address.confidential_address,
                amount: "600".to_owned(),
                fee: "2000".to_owned(),
            },
        )?;
        assert_eq!(transfer.operation, "transfer");
        let transfer_transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(transfer.transaction)?)?;
        assert_eq!(
            transfer_transaction.output[1].asset.explicit(),
            Some(regulated_asset)
        );
        assert_eq!(transfer_transaction.output[1].value.explicit(), Some(600));
        assert_eq!(
            transfer_transaction.output[2].asset.explicit(),
            Some(regulated_asset)
        );
        assert_eq!(transfer_transaction.output[2].value.explicit(), Some(400));
        Ok(())
    }

    #[test]
    fn fixed_supply_bootstrap_uses_null_reissuance_fields() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let policy_asset = AssetId::from_str(&"bb".repeat(32))?;
        let funding = vec![
            confidential_funding_utxo(&signer, network, policy_asset, 50_000, 0)?,
            confidential_funding_utxo(&signer, network, policy_asset, 50_000, 1)?,
        ];
        let bootstrapped = bootstrap::bootstrap(
            &signer,
            network,
            BootstrapRequest {
                network: DeploymentNetwork::ElementsRegtest,
                policy_asset: policy_asset.to_string(),
                deployment_salt: "33".repeat(32),
                asset: AssetMetadata {
                    name: "Fixed supply test".to_owned(),
                    ticker: "FIX".to_owned(),
                    precision: 0,
                },
                issued_supply: "1000".to_owned(),
                supply_mode: SupplyMode::Fixed,
                policy_utxos: funding,
                fee: "2000".to_owned(),
                required_confirmations: 1,
            },
        )?;
        assert!(bootstrapped.deployment.reissuance_token.is_none());
        assert!(bootstrapped.deployment.reissuance_entropy.is_none());
        let transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(&bootstrapped.transaction)?)?;
        assert_eq!(
            transaction.input[0].asset_issuance.inflation_keys,
            Value::Null
        );
        assert_eq!(
            transaction.input[1].asset_issuance.inflation_keys,
            Value::Null
        );
        Ok(())
    }

    #[test]
    fn bootstrap_extends_confidential_selection_for_split_change() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let policy_asset = AssetId::from_str(&"bc".repeat(32))?;
        let funding = vec![
            confidential_funding_utxo(&signer, network, policy_asset, 1_000, 0)?,
            confidential_funding_utxo(&signer, network, policy_asset, 1_000, 1)?,
            confidential_funding_utxo(&signer, network, policy_asset, 5_000, 2)?,
        ];
        let result = bootstrap::bootstrap(
            &signer,
            network,
            BootstrapRequest {
                network: DeploymentNetwork::ElementsRegtest,
                policy_asset: policy_asset.to_string(),
                deployment_salt: "44".repeat(32),
                asset: AssetMetadata {
                    name: "Confidential headroom test".to_owned(),
                    ticker: "CHT".to_owned(),
                    precision: 0,
                },
                issued_supply: "1000".to_owned(),
                supply_mode: SupplyMode::Fixed,
                policy_utxos: funding,
                fee: "2000".to_owned(),
                required_confirmations: 1,
            },
        )?;
        let transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(result.transaction)?)?;
        assert_eq!(transaction.input.len(), 3);
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

    fn confidential_funding_utxo(
        signer: &SwSigner,
        network: SignerNetwork,
        asset: AssetId,
        value: u64,
        index: u32,
    ) -> anyhow::Result<SpendableUtxo> {
        let derived = keys::derive_wallet_address(signer, network, 0, index)?;
        let address = Address::from_str(&derived.confidential_address)?;
        let blinder = address
            .blinding_pubkey
            .context("derived address is not confidential")?;
        let spent = [TxOutSecrets::new(
            asset,
            AssetBlindingFactor::zero(),
            value,
            ValueBlindingFactor::zero(),
        )];
        let (txout, _abf, _vbf, _ephemeral) = TxOut::new_last_confidential(
            &mut rand::thread_rng(),
            elements::secp256k1_zkp::SECP256K1,
            value,
            asset,
            address.script_pubkey(),
            blinder,
            &spent,
            &[],
        )?;
        let parent = elements::Transaction {
            version: 2,
            lock_time: elements::LockTime::ZERO,
            input: Vec::new(),
            output: vec![txout],
        };
        Ok(SpendableUtxo {
            txid: parent.txid().to_string(),
            vout: 0,
            tx_out: None,
            transaction: Some(hex::encode(elements::encode::serialize(&parent))),
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
