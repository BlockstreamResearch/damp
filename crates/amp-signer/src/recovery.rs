//! Issuer recovery from the actual transaction witness. Chain inclusion is a
//! separate indexer responsibility; this module verifies the covenant statement.
use crate::{keys, policy::protocol_for_deployment};
use amp_core::{
    native_audit::{
        AUXILIARY_BYTES, AuditStatement, MAX_AUDIT_VALUE, NativeAuditProof, open_recovery,
        recover_bounded_dlp, recovery_context,
    },
    registry::{DeploymentManifestV1, PolicySnapshotV1},
};
use anyhow::Context;
use elements::{
    Transaction,
    hashes::{Hash, sha256},
    pset::PartiallySignedTransaction,
    secp256k1_zkp::{PublicKey, Secp256k1},
};
use lwk_signer::SwSigner;
use serde::{Deserialize, Serialize};
use simplicityhl::simplicity::{
    dag::{DagLike, InternalSharing},
    node::Inner,
};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRequest {
    pub deployment: DeploymentManifestV1,
    pub policy: PolicySnapshotV1,
    pub transaction: String,
    pub previous_transactions: Vec<String>,
    #[serde(default)]
    pub dlp_upper_bound: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredOutput {
    pub outpoint: String,
    pub amount: Option<String>,
    pub recovery_status: &'static str,
    pub auxiliary_status: &'static str,
    pub application_bounds: &'static str,
    pub script_pubkey: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryResult {
    pub transaction_id: String,
    pub covenant_verified: bool,
    pub chain_inclusion: &'static str,
    pub outputs: Vec<RecoveredOutput>,
}
struct Bits {
    bits: Vec<bool>,
    offset: usize,
}
impl Bits {
    fn take(&mut self, n: usize) -> anyhow::Result<Vec<u8>> {
        anyhow::ensure!(
            self.offset + n <= self.bits.len(),
            "truncated audit witness"
        );
        let mut bytes = vec![0; n.div_ceil(8)];
        for i in 0..n {
            bytes[i / 8] |= u8::from(self.bits[self.offset + i]) << (7 - i % 8);
        }
        self.offset += n;
        Ok(bytes)
    }
    fn bit(&mut self) -> anyhow::Result<u8> {
        Ok(self.take(1)?[0] >> 7)
    }
    fn word(&mut self) -> anyhow::Result<[u8; 32]> {
        Ok(self.take(256)?.try_into().expect("32 bytes"))
    }
    fn point(&mut self) -> anyhow::Result<PublicKey> {
        let mut p = vec![2 + self.bit()?];
        p.extend(self.word()?);
        Ok(PublicKey::from_slice(&p)?)
    }
}
const RECORD_BITS: usize = 42868;

pub fn recover(signer: &SwSigner, request: RecoveryRequest) -> anyhow::Result<RecoveryResult> {
    let index = keys::derive_key_index(&request.deployment.deployment_salt, "audit")?;
    let (_, key) = keys::derive_xprv(signer, "audit", index)?;
    recover_key(&key.private_key, request)
}
pub(crate) fn recover_key(
    secret: &elements::secp256k1_zkp::SecretKey,
    request: RecoveryRequest,
) -> anyhow::Result<RecoveryResult> {
    let deployment_id = request.deployment.validate()?;
    anyhow::ensure!(
        request.policy.deployment_id == deployment_id
            && request.policy.protocol == request.deployment.protocol,
        "policy deployment mismatch"
    );
    let policy = request.policy.validate()?;
    let protocol = protocol_for_deployment(&request.deployment)?;
    let parameters = protocol
        .audit()
        .context("this deployment has no native audit protocol")?;
    anyhow::ensure!(
        request.dlp_upper_bound <= (1u64 << 32),
        "DLP bound exceeds per-call cap"
    );
    anyhow::ensure!(
        PublicKey::from_secret_key(&Secp256k1::new(), secret) == parameters.key,
        "issuer audit key unavailable for this deployment"
    );
    recover_with_key(secret, request, &protocol, policy.commitment())
}
fn recover_with_key(
    secret: &elements::secp256k1_zkp::SecretKey,
    request: RecoveryRequest,
    protocol: &crate::protocol::Protocol,
    policy: amp_core::SetCommitment,
) -> anyhow::Result<RecoveryResult> {
    let parameters = protocol.audit().context("missing audit parameters")?;
    anyhow::ensure!(
        request.transaction.len() <= 800_000 && request.previous_transactions.len() <= 256,
        "recovery request too large"
    );
    let tx: Transaction = elements::encode::deserialize(&hex::decode(&request.transaction)?)?;
    let mut previous = HashMap::new();
    for raw in request.previous_transactions {
        anyhow::ensure!(raw.len() <= 8_000_000, "previous transaction too large");
        let prev: Transaction = elements::encode::deserialize(&hex::decode(raw)?)?;
        anyhow::ensure!(
            previous.insert(prev.txid(), prev).is_none(),
            "duplicate previous transaction"
        );
    }
    let mut pset = PartiallySignedTransaction::from_tx(tx.clone());
    for (input, source) in pset.inputs_mut().iter_mut().zip(&tx.input) {
        let prev = previous
            .get(&source.previous_output.txid)
            .context("previous transaction unavailable; recovery data not evaluated")?;
        input.witness_utxo = Some(
            prev.output
                .get(source.previous_output.vout as usize)
                .context("previous outpoint out of range")?
                .clone(),
        );
    }
    let (program, sighash) = protocol
        .anchor(policy)?
        .verify_transfer_witness(&pset, request.deployment.network)?;
    let candidates = program
        .as_ref()
        .post_order_iter::<InternalSharing>()
        .filter_map(|item| match item.node.inner() {
            Inner::Witness(value) => {
                let bits = value.iter_compact().collect::<Vec<_>>();
                (bits.len() >= 10 + RECORD_BITS
                    && bits.len() <= 10 + 10 * RECORD_BITS
                    && (bits.len() - 10) % RECORD_BITS == 0)
                    .then_some(bits)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    anyhow::ensure!(
        candidates.len() == 1,
        "expected unique canonical audit-record witness"
    );
    let mut reader = Bits {
        bits: candidates.into_iter().next().expect("one"),
        offset: 0,
    };
    let mut rows = Vec::new();
    for _ in 0..10 {
        if reader.bit()? == 0 {
            continue;
        }
        let index = u32::from_be_bytes(reader.take(32)?.try_into().expect("four bytes"));
        let proof = NativeAuditProof {
            commitment_parity: reader.bit()? == 1,
            commitment_root: reader.word()?,
            handle: reader.point()?,
            commitment_nonce: reader.point()?,
            handle_nonce: reader.point()?,
            value_response: reader.word()?,
            blinder_response: reader.word()?,
        };
        let auxiliary: [u8; AUXILIARY_BYTES] = reader
            .take(AUXILIARY_BYTES * 8)?
            .try_into()
            .expect("aux bytes");
        let range_body = reader.take(5060 * 8)?;
        let output = tx
            .output
            .get(index as usize)
            .context("audit output out of range")?;
        let range = output
            .witness
            .rangeproof
            .as_deref()
            .context("range proof missing")?
            .serialize();
        anyhow::ensure!(
            range.len() == 5070
                && range[..10] == [0x60, 0x3e, 0, 0, 0, 0, 0, 0, 0, 1]
                && range[10..] == range_body,
            "wrong native range interval"
        );
        let statement = AuditStatement {
            deployment: parameters.deployment,
            epoch: parameters.epoch,
            audit_key: parameters.key,
            sig_all_hash: sighash,
            output_index: index,
            asset: protocol
                .config()
                .regulated_asset
                .into_inner()
                .to_byte_array(),
            commitment: output
                .value
                .commitment()
                .context("regulated value is explicit")?,
            script_hash: sha256::Hash::hash(output.script_pubkey.as_bytes()).to_byte_array(),
            auxiliary,
        };
        proof.verify(&statement)?;
        let context = recovery_context(
            statement.deployment,
            statement.epoch,
            index,
            statement.asset,
            statement.commitment,
            statement.script_hash,
        );
        let (value, status, aux_status) = match open_recovery(secret, context, &statement, &proof) {
            Ok(opening) => (Some(opening.value()), "recovered", "valid"),
            Err(_) => {
                let aux = if auxiliary == [0; AUXILIARY_BYTES] {
                    "missing"
                } else {
                    "invalid"
                };
                let value = if request.dlp_upper_bound > 0 {
                    recover_bounded_dlp(secret, &statement, &proof, request.dlp_upper_bound)?
                } else {
                    None
                };
                (
                    value,
                    if value.is_some() {
                        "recovered-by-bounded-dlp"
                    } else if request.dlp_upper_bound > 0 {
                        "bounded-dlp-exhausted"
                    } else {
                        "recovery-required"
                    },
                    aux,
                )
            }
        };
        rows.push(RecoveredOutput {
            outpoint: format!("{}:{index}", tx.txid()),
            amount: value.map(|v| v.to_string()),
            recovery_status: status,
            auxiliary_status: aux_status,
            application_bounds: match value {
                Some(v) if v > MAX_AUDIT_VALUE => "outside-application-cap",
                Some(_) => "within-application-cap",
                None => "unknown",
            },
            script_pubkey: hex::encode(output.script_pubkey.as_bytes()),
        });
    }
    anyhow::ensure!(
        reader.offset == reader.bits.len(),
        "unused audit witness bits"
    );
    Ok(RecoveryResult {
        transaction_id: tx.txid().to_string(),
        covenant_verified: true,
        chain_inclusion: "requires-independent-chain-verification",
        outputs: rows,
    })
}

/// Public chain decoding for the bounded indexer; no openings or wallet metadata.
pub fn public_transaction(raw: &str) -> anyhow::Result<serde_json::Value> {
    anyhow::ensure!(raw.len() <= 8_000_000, "transaction too large");
    let tx: Transaction = elements::encode::deserialize(&hex::decode(raw)?)?;
    let inputs=tx.input.iter().map(|i| {
        let issuance=if i.has_issuance() {
            let (asset,token)=i.issuance_ids();
            Some(serde_json::json!({"asset":asset.to_string(),"token":token.to_string(),"amount":i.asset_issuance.amount.explicit().map(|v|v.to_string()),"reissuance":i.asset_issuance.asset_blinding_nonce!=elements::secp256k1_zkp::ZERO_TWEAK}))
        }else{None};
        serde_json::json!({"outpoint":format!("{}:{}",i.previous_output.txid,i.previous_output.vout),"issuance":issuance,"leaf":i.witness.script_witness.get(2).map(hex::encode)})
    }).collect::<Vec<_>>();
    let outputs=tx.output.iter().enumerate().map(|(index,o)|serde_json::json!({"outpoint":format!("{}:{index}",tx.txid()),"asset":o.asset.explicit().map(|a|a.to_string()),"amount":o.value.explicit().map(|v|v.to_string()),"scriptPubkey":hex::encode(o.script_pubkey.as_bytes()),"unspendable":o.script_pubkey.is_provably_unspendable()})).collect::<Vec<_>>();
    Ok(serde_json::json!({"txid":tx.txid().to_string(),"inputs":inputs,"outputs":outputs}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignReportRequest {
    pub deployment: DeploymentManifestV1,
    pub report_json: String,
}
pub fn sign_report(
    signer: &SwSigner,
    request: SignReportRequest,
) -> anyhow::Result<serde_json::Value> {
    use elements::secp256k1_zkp::{Keypair, Message};
    let id = request.deployment.validate()?;
    anyhow::ensure!(request.report_json.len() <= 4_000_000, "report too large");
    let value: serde_json::Value = serde_json::from_str(&request.report_json)?;
    anyhow::ensure!(
        value["deploymentId"].as_str() == Some(&id)
            && value["network"].as_str() == Some(request.deployment.network.as_str()),
        "report deployment mismatch"
    );
    let index = keys::derive_key_index(&request.deployment.deployment_salt, "issuer")?;
    let (_, mut key) = keys::derive_xprv(signer, "issuer", index)?;
    let result = (|| {
        anyhow::ensure!(
            keys::xonly_from_xprv(&key).to_string() == request.deployment.issuer_public_key,
            "issuer signing key unavailable"
        );
        let mut bytes = b"DAMP/audit/report-signature/v2\0".to_vec();
        bytes.extend(request.report_json.as_bytes());
        let digest = sha256::Hash::hash(&bytes).to_byte_array();
        let pair = Keypair::from_secret_key(&Secp256k1::new(), &key.private_key);
        let signature = Secp256k1::new().sign_schnorr(&Message::from_digest(digest), &pair);
        Ok(
            serde_json::json!({"algorithm":"BIP340-SHA256-DAMP-report-v2","digest":hex::encode(digest),"signature":signature.to_string(),"publicKey":request.deployment.issuer_public_key}),
        )
    })();
    key.private_key.non_secure_erase();
    result
}
