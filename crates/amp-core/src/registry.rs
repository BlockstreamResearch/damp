//! Strict public registry records for AMP v0.1.

use std::str::FromStr;

use anyhow::Context;
use secp256k1_zkp::XOnlyPublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::policy::{PolicySet, TreeDepth, decode_hex_32, outpoint_key};

pub const REGISTRY_SCHEMA_V1: &str = "simplicity-amp-registry-v1";
pub const PROTOCOL_ID_V1: &str = "simplicity-amp/v0.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeploymentNetwork {
    LiquidTestnet,
    ElementsRegtest,
}

impl DeploymentNetwork {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LiquidTestnet => "liquid-testnet",
            Self::ElementsRegtest => "elements-regtest",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetMetadata {
    pub name: String,
    pub ticker: String,
    pub precision: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SupplyMode {
    Fixed,
    IssuerManaged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentManifestV1 {
    pub schema: String,
    pub protocol: String,
    pub network: DeploymentNetwork,
    pub policy_asset: String,
    pub regulated_asset: String,
    pub verifier_asset: String,
    pub verifier_asset_amount: u64,
    pub issuer_public_key: String,
    pub deployment_salt: String,
    pub genesis_anchor: String,
    pub asset: AssetMetadata,
    pub issued_supply: String,
    pub supply_mode: SupplyMode,
    pub reissuance_token: Option<String>,
    pub reissuance_entropy: Option<String>,
    pub user_program_hash: String,
    pub governance_program_hash: String,
    pub contract_bundle_hash: String,
}

impl DeploymentManifestV1 {
    pub fn validate(&self) -> anyhow::Result<String> {
        require_header(&self.schema, &self.protocol)?;
        anyhow::ensure!(
            self.verifier_asset_amount == 1,
            "v0.1 requires one verifier unit"
        );
        let issued_supply = self
            .issued_supply
            .parse::<u64>()
            .context("issued supply must fit u64")?;
        anyhow::ensure!(issued_supply > 0, "issued supply must be non-zero");
        anyhow::ensure!(
            (1..=80).contains(&self.asset.name.trim().len()),
            "asset name must be 1..=80 characters"
        );
        anyhow::ensure!(
            (1..=12).contains(&self.asset.ticker.trim().len()),
            "asset ticker must be 1..=12 characters"
        );
        anyhow::ensure!(
            self.asset.precision <= 8,
            "asset precision must be at most eight"
        );
        validate_hash("policy asset", &self.policy_asset)?;
        validate_hash("regulated asset", &self.regulated_asset)?;
        validate_hash("verifier asset", &self.verifier_asset)?;
        anyhow::ensure!(
            self.policy_asset != self.regulated_asset
                && self.policy_asset != self.verifier_asset
                && self.regulated_asset != self.verifier_asset,
            "policy, regulated, and verifier assets must be distinct"
        );
        validate_xonly("issuer public key", &self.issuer_public_key)?;
        validate_hash("deployment salt", &self.deployment_salt)?;
        validate_outpoint("genesis anchor", &self.genesis_anchor)?;
        validate_hash("user program hash", &self.user_program_hash)?;
        validate_hash("governance program hash", &self.governance_program_hash)?;
        validate_hash("contract bundle hash", &self.contract_bundle_hash)?;
        match (
            &self.supply_mode,
            &self.reissuance_token,
            &self.reissuance_entropy,
        ) {
            (SupplyMode::Fixed, None, None) => {}
            (SupplyMode::IssuerManaged, Some(token), Some(entropy)) => {
                validate_hash("reissuance token", token)?;
                validate_hash("reissuance entropy", entropy)?;
            }
            _ => anyhow::bail!(
                "reissuance token and entropy must exist exactly for issuer-managed supply"
            ),
        }
        Ok(self.deployment_id())
    }

    #[must_use]
    pub fn deployment_id(&self) -> String {
        let mut hasher = Sha256::new();
        for value in [
            self.schema.as_str(),
            self.protocol.as_str(),
            self.network.as_str(),
            self.policy_asset.as_str(),
            self.regulated_asset.as_str(),
            self.verifier_asset.as_str(),
            self.issuer_public_key.as_str(),
            self.deployment_salt.as_str(),
            self.genesis_anchor.as_str(),
            self.asset.name.as_str(),
            self.asset.ticker.as_str(),
            self.user_program_hash.as_str(),
            self.governance_program_hash.as_str(),
            self.contract_bundle_hash.as_str(),
            self.reissuance_token.as_deref().unwrap_or(""),
            self.reissuance_entropy.as_deref().unwrap_or(""),
        ] {
            hash_len_prefixed(&mut hasher, value.as_bytes());
        }
        hasher.update(self.verifier_asset_amount.to_be_bytes());
        hasher.update(
            self.issued_supply
                .parse::<u64>()
                .expect("validated manifests contain a u64 supply")
                .to_be_bytes(),
        );
        hasher.update([self.asset.precision]);
        hasher.update([match self.supply_mode {
            SupplyMode::Fixed => 0,
            SupplyMode::IssuerManaged => 1,
        }]);
        hex::encode(hasher.finalize())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlacklistEntryV1 {
    pub txid: String,
    pub vout: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BlacklistEntryV1 {
    pub fn key(&self) -> anyhow::Result<[u8; 32]> {
        outpoint_key(&self.txid, self.vout)
    }

    fn validate(&self) -> anyhow::Result<()> {
        validate_hash("blacklist transaction id", &self.txid)?;
        if let Some(note) = &self.note {
            anyhow::ensure!(
                note.trim().len() <= 280,
                "blacklist note exceeds 280 characters"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicySnapshotV1 {
    pub schema: String,
    pub protocol: String,
    pub deployment_id: String,
    pub sequence: u64,
    pub parent_policy_root: Option<String>,
    pub parent_verifier_script_hash: Option<String>,
    pub tree_depth: TreeDepth,
    pub set_root: String,
    pub entry_count: u32,
    pub policy_root: String,
    pub verifier_program_hash: String,
    pub verifier_script_pubkey: String,
    pub entries: Vec<BlacklistEntryV1>,
}

impl PolicySnapshotV1 {
    pub fn validate(&self) -> anyhow::Result<PolicySet> {
        require_header(&self.schema, &self.protocol)?;
        validate_hash("deployment id", &self.deployment_id)?;
        validate_hash("set root", &self.set_root)?;
        validate_hash("policy root", &self.policy_root)?;
        validate_hash("verifier program hash", &self.verifier_program_hash)?;
        validate_script(&self.verifier_script_pubkey)?;
        match (&self.parent_policy_root, &self.parent_verifier_script_hash) {
            (None, None) if self.sequence == 0 => {}
            (Some(policy), Some(script)) if self.sequence > 0 => {
                validate_hash("parent policy root", policy)?;
                validate_hash("parent verifier script hash", script)?;
            }
            _ => anyhow::bail!(
                "policy parent fields must both be present exactly after sequence zero"
            ),
        }
        for entry in &self.entries {
            entry.validate()?;
        }
        anyhow::ensure!(
            self.entries
                .windows(2)
                .all(|pair| (&pair[0].txid, pair[0].vout) < (&pair[1].txid, pair[1].vout)),
            "blacklist entries must be strictly sorted by txid and vout"
        );
        let keys = self
            .entries
            .iter()
            .map(BlacklistEntryV1::key)
            .collect::<anyhow::Result<Vec<_>>>()?;
        let tree = PolicySet::new(self.tree_depth, keys)?;
        let commitment = tree.commitment();
        anyhow::ensure!(
            self.entry_count == commitment.count,
            "blacklist entry count mismatch"
        );
        anyhow::ensure!(
            self.set_root == hex::encode(commitment.root),
            "blacklist set root mismatch"
        );
        anyhow::ensure!(
            self.policy_root == hex::encode(commitment.policy_digest()),
            "blacklist policy root mismatch"
        );
        Ok(tree)
    }

    pub fn verifier_script_hash(&self) -> anyhow::Result<String> {
        let script = hex::decode(&self.verifier_script_pubkey)?;
        Ok(hex::encode(Sha256::digest(script)))
    }

    pub fn registry_path(&self) -> anyhow::Result<String> {
        Ok(format!(
            "policies/{}/{}.json",
            self.deployment_id,
            self.verifier_script_hash()?
        ))
    }
}

fn require_header(schema: &str, protocol: &str) -> anyhow::Result<()> {
    anyhow::ensure!(schema == REGISTRY_SCHEMA_V1, "unsupported registry schema");
    anyhow::ensure!(protocol == PROTOCOL_ID_V1, "unsupported AMP protocol");
    Ok(())
}

fn validate_hash(name: &str, value: &str) -> anyhow::Result<()> {
    decode_hex_32(name, value).map(|_| ())
}

fn validate_xonly(name: &str, value: &str) -> anyhow::Result<()> {
    validate_hash(name, value)?;
    XOnlyPublicKey::from_str(value).with_context(|| format!("invalid {name}"))?;
    Ok(())
}

fn validate_outpoint(name: &str, value: &str) -> anyhow::Result<()> {
    let (txid, vout) = value
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("{name} must be txid:vout"))?;
    validate_hash(name, txid)?;
    vout.parse::<u32>()
        .with_context(|| format!("invalid {name} output index"))?;
    Ok(())
}

fn validate_script(value: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len().is_multiple_of(2),
        "scriptPubKey must be non-empty hex"
    );
    anyhow::ensure!(
        value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "scriptPubKey must be lowercase hex"
    );
    hex::decode(value)?;
    Ok(())
}

fn hash_len_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u32).to_be_bytes());
    hasher.update(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(byte: u8, vout: u32) -> BlacklistEntryV1 {
        BlacklistEntryV1 {
            txid: hex::encode([byte; 32]),
            vout,
            note: Some("metadata only".to_owned()),
        }
    }

    #[test]
    fn notes_do_not_change_consensus_commitments() -> anyhow::Result<()> {
        let with_note = entry(1, 0);
        let mut without_note = with_note.clone();
        without_note.note = None;
        let a = PolicySet::new(TreeDepth::D4, [with_note.key()?])?.commitment();
        let b = PolicySet::new(TreeDepth::D4, [without_note.key()?])?.commitment();
        assert_eq!(a, b);
        Ok(())
    }

    #[test]
    fn serde_rejects_unknown_manifest_fields() {
        let value = serde_json::json!({ "schema": REGISTRY_SCHEMA_V1, "unexpected": true });
        assert!(serde_json::from_value::<DeploymentManifestV1>(value).is_err());
    }

    #[test]
    fn shared_registry_fixtures_are_semantically_valid() -> anyhow::Result<()> {
        let manifest: DeploymentManifestV1 = serde_json::from_str(include_str!(
            "../../../registry/fixtures/deployment.valid.json"
        ))?;
        manifest.validate()?;
        let policy: PolicySnapshotV1 =
            serde_json::from_str(include_str!("../../../registry/fixtures/policy.valid.json"))?;
        policy.validate()?;
        Ok(())
    }

    #[test]
    fn manifest_rejects_asset_role_collisions() -> anyhow::Result<()> {
        let mut manifest: DeploymentManifestV1 = serde_json::from_str(include_str!(
            "../../../registry/fixtures/deployment.valid.json"
        ))?;
        manifest.verifier_asset = manifest.regulated_asset.clone();
        assert!(manifest.validate().is_err());
        Ok(())
    }
}
