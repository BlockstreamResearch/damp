use damp_core::ledger::Outpoint;
use damp_core::registry::{BlacklistEntry, DeploymentManifest, PolicySnapshot};
use serde::{Serialize, de::DeserializeOwned};
use wasm_bindgen::prelude::*;

use crate::{Signer, keys, ops};

#[wasm_bindgen]
pub struct DampSigner {
    inner: Signer,
}

#[wasm_bindgen]
impl DampSigner {
    #[wasm_bindgen(constructor)]
    pub fn new(mnemonic: &str, network: JsValue) -> Result<DampSigner, JsError> {
        Ok(Self {
            inner: Signer::new(mnemonic, from_js(network)?).map_err(js_error)?,
        })
    }

    #[wasm_bindgen(js_name=info)]
    pub fn info(&self) -> Result<JsValue, JsError> {
        to_js(&self.inner.info().map_err(js_error)?)
    }

    #[wasm_bindgen(js_name=deriveDampKey)]
    pub fn derive_damp_key(&self, deployment_salt: &str, role: &str) -> Result<JsValue, JsError> {
        to_js(
            &self
                .inner
                .derive_damp_key(
                    &deployment_salt.parse().map_err(js_error)?,
                    role.parse().map_err(js_error)?,
                )
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name=deriveWalletAddress)]
    pub fn wallet_address(&self, branch: JsValue, index: JsValue) -> Result<JsValue, JsError> {
        to_js(
            &self
                .inner
                .wallet_address(from_js(branch)?, from_js(index)?)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name=inspectUtxos)]
    pub fn inspect(&self, value: JsValue) -> Result<JsValue, JsError> {
        to_js(
            &self
                .inner
                .inspect(&from_js::<Vec<_>>(value)?)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name=deriveHolderAddress)]
    pub fn holder_address(&self, value: JsValue) -> Result<JsValue, JsError> {
        to_js(
            &self
                .inner
                .holder_address(&from_js(value)?)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name=validateRecipientAddress)]
    pub fn validate_recipient_address(
        &self,
        deployment: JsValue,
        address: &str,
    ) -> Result<String, JsError> {
        Ok(self
            .inner
            .validate_recipient_address(&from_js(deployment)?, &address.parse().map_err(js_error)?)
            .map_err(js_error)?
            .owner()
            .to_string())
    }

    #[wasm_bindgen(js_name=signTransfer)]
    pub fn transfer(&self, value: JsValue) -> Result<JsValue, JsError> {
        to_js(&self.inner.transfer(from_js(value)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name=signPolicyUpdate)]
    pub fn update_policy(&self, value: JsValue) -> Result<JsValue, JsError> {
        to_js(
            &self
                .inner
                .update_policy(from_js(value)?)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name=bootstrap)]
    pub fn bootstrap(&self, value: JsValue) -> Result<JsValue, JsError> {
        to_js(&self.inner.bootstrap(from_js(value)?).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name=splitFunding)]
    pub fn split_funding(&self, value: JsValue) -> Result<JsValue, JsError> {
        to_js(
            &self
                .inner
                .split_funding(from_js(value)?)
                .map_err(js_error)?,
        )
    }

    #[wasm_bindgen(js_name=reissue)]
    pub fn reissue(&self, value: JsValue) -> Result<JsValue, JsError> {
        to_js(&self.inner.reissue(from_js(value)?).map_err(js_error)?)
    }
}

#[wasm_bindgen(js_name=preparePolicy)]
pub fn prepare_policy(value: JsValue) -> Result<JsValue, JsError> {
    to_js(&Signer::prepare_policy(from_js(value)?).map_err(js_error)?)
}

#[wasm_bindgen(js_name=validateDeployment)]
pub fn validate_deployment(value: JsValue) -> Result<String, JsError> {
    Ok(from_js::<DeploymentManifest>(value)?
        .deployment_id()
        .to_string())
}

#[wasm_bindgen(js_name=validatePolicySnapshot)]
pub fn validate_policy_snapshot(value: JsValue) -> Result<JsValue, JsError> {
    to_js(&from_js::<PolicySnapshot>(value)?.tree().commitment())
}

#[wasm_bindgen(js_name=buildBlacklist)]
pub fn build_blacklist(entries: JsValue, depth: JsValue) -> Result<JsValue, JsError> {
    to_js(&ops::policy::build_blacklist(from_js(depth)?, from_js(entries)?).map_err(js_error)?)
}

#[wasm_bindgen(js_name=proveBlacklistNonMembership)]
pub fn prove_non_membership(
    entries: JsValue,
    depth: JsValue,
    txid: &str,
    vout: JsValue,
) -> Result<JsValue, JsError> {
    let entries: Vec<BlacklistEntry> = from_js(entries)?;
    let outpoint = Outpoint::new(txid.parse().map_err(js_error)?, from_js(vout)?);
    to_js(
        &ops::policy::prove_non_membership(from_js(depth)?, &entries, outpoint)
            .map_err(js_error)?,
    )
}

#[wasm_bindgen(js_name=deriveKeyIndex)]
pub fn derive_key_index(deployment_salt: &str, role: &str) -> Result<u32, JsError> {
    keys::derive_key_index(
        &deployment_salt.parse().map_err(js_error)?,
        role.parse().map_err(js_error)?,
    )
    .map(|index| index.get())
    .map_err(js_error)
}

#[wasm_bindgen(js_name=generateMnemonic)]
pub fn generate_mnemonic() -> Result<String, JsError> {
    let (_, mnemonic) = lwk_signer::SwSigner::random(false).map_err(js_error)?;
    Ok(mnemonic.to_string())
}

#[wasm_bindgen(js_name=verifyAuditReport)]
pub fn verify_audit_report(
    report_json: &str,
    signature: &str,
    issuer_public_key: &str,
) -> Result<(), JsError> {
    crate::audit::signature::verify_report(
        report_json,
        &signature.parse().map_err(js_error)?,
        issuer_public_key.parse().map_err(js_error)?,
    )
    .map_err(js_error)
}

fn from_js<T: DeserializeOwned>(value: JsValue) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(value).map_err(Into::into)
}
fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
fn to_js(value: &impl Serialize) -> Result<JsValue, JsError> {
    // Registry parent and supply fields require explicit JSON nulls.
    value
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
        .map_err(Into::into)
}
