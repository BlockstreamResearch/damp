use std::str::FromStr;

use amp_core::registry::{DeploymentNetwork, PROTOCOL_ID_V1, REGISTRY_SCHEMA_V1, ReceiveRecordV1};
use anyhow::Context;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use elements::Address;
use elements::bitcoin::{
    Address as BitcoinAddress, Amount, CompressedPublicKey, EcdsaSighashType, Network, OutPoint,
    ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness, absolute,
    consensus::{deserialize, serialize},
    hashes::{Hash as _, HashEngine as _, sha256},
    opcodes::all::OP_RETURN,
    script::{Builder, PushBytesBuf},
    sighash::SighashCache,
    transaction::Version,
};
use elements::secp256k1_zkp::PublicKey;
use lwk_signer::SwSigner;

use crate::keys::{blinding_public_key, derive_key_index, derive_xprv, xonly_from_xprv};
use crate::model::{
    CreateReceiveRecordRequest, CreatedReceiveRecord, SIGNER_SDK_VERSION, SignerNetwork,
    ValidateReceiveRecordRequest,
};
use crate::policy::protocol_for_deployment;

pub fn create_receive_record(
    signer: &SwSigner,
    network: SignerNetwork,
    request: CreateReceiveRecordRequest,
) -> anyhow::Result<CreatedReceiveRecord> {
    let computed_id = request.deployment.validate()?;
    anyhow::ensure!(
        computed_id == request.deployment_id,
        "deployment ID mismatch"
    );
    ensure_network(network, request.deployment.network)?;
    anyhow::ensure!(
        request.alias == request.alias.trim() && !request.alias.is_empty(),
        "receive alias must be canonical trimmed text"
    );

    let index = derive_key_index(&request.deployment.deployment_salt, "holder")?;
    let (_path, xprv) = derive_xprv(signer, "holder", index)?;
    let owner = xonly_from_xprv(&xprv);
    let protocol = protocol_for_deployment(&request.deployment)?;
    let script = protocol.user_script(owner)?;
    let blinding_key = blinding_public_key(signer, &script)?;
    let address = Address::from_script(&script, Some(blinding_key), protocol.address_params())
        .context("holder script cannot be represented as an Elements address")?;
    let bitcoin_public = xprv
        .private_key
        .public_key(elements::secp256k1_zkp::SECP256K1);
    let proof_address = BitcoinAddress::p2wpkh(
        &CompressedPublicKey(bitcoin_public),
        bip322_network(network),
    );
    let mut record = ReceiveRecordV1 {
        schema: REGISTRY_SCHEMA_V1.to_owned(),
        protocol: PROTOCOL_ID_V1.to_owned(),
        deployment_id: computed_id,
        alias: request.alias,
        owner_public_key: owner.to_string(),
        script_pubkey: hex::encode(script.as_bytes()),
        confidential_address: address.to_string(),
        blinding_public_key: blinding_key.to_string(),
        proof_address: proof_address.to_string(),
        bip322_signature: String::new(),
    };
    record.bip322_signature = sign_bip322_simple(&record.signing_message(), &xprv.private_key)?;
    validate_receive_record(
        network,
        ValidateReceiveRecordRequest {
            deployment: request.deployment,
            record: record.clone(),
        },
    )?;
    Ok(CreatedReceiveRecord {
        sdk: SIGNER_SDK_VERSION,
        derivation_index: index,
        record,
    })
}

pub fn validate_receive_record(
    network: SignerNetwork,
    request: ValidateReceiveRecordRequest,
) -> anyhow::Result<()> {
    let deployment_id = request.deployment.validate()?;
    ensure_network(network, request.deployment.network)?;
    request.record.validate_shape()?;
    anyhow::ensure!(
        request.record.deployment_id == deployment_id,
        "receive record belongs to another deployment"
    );
    anyhow::ensure!(
        request.record.alias == request.record.alias.trim(),
        "receive alias is not canonical"
    );
    let protocol = protocol_for_deployment(&request.deployment)?;
    let owner = elements::schnorr::XOnlyPublicKey::from_str(&request.record.owner_public_key)?;
    let expected_script = protocol.user_script(owner)?;
    anyhow::ensure!(
        hex::encode(expected_script.as_bytes()) == request.record.script_pubkey,
        "receive record script does not commit the declared owner"
    );
    let address = Address::from_str(&request.record.confidential_address)?;
    anyhow::ensure!(
        address.params == protocol.address_params(),
        "receive address network mismatch"
    );
    anyhow::ensure!(
        address.script_pubkey() == expected_script,
        "receive address script mismatch"
    );
    anyhow::ensure!(
        address.blinding_pubkey == Some(PublicKey::from_str(&request.record.blinding_public_key)?),
        "receive address blinding key mismatch"
    );
    anyhow::ensure!(
        verify_bip322_simple(
            &request.record.signing_message(),
            &request.record.proof_address,
            &request.record.bip322_signature,
            &request.record.owner_public_key,
            bip322_network(network),
        )?,
        "invalid BIP322 ownership proof"
    );
    Ok(())
}

pub(crate) fn ensure_network(
    network: SignerNetwork,
    deployment: DeploymentNetwork,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(
            (network, deployment),
            (
                SignerNetwork::LiquidTestnet,
                DeploymentNetwork::LiquidTestnet
            ) | (
                SignerNetwork::ElementsRegtest,
                DeploymentNetwork::ElementsRegtest
            )
        ),
        "signer network does not match deployment"
    );
    Ok(())
}

fn bip322_network(network: SignerNetwork) -> Network {
    match network {
        SignerNetwork::LiquidTestnet => Network::Testnet,
        SignerNetwork::ElementsRegtest => Network::Regtest,
    }
}

fn sign_bip322_simple(
    message: &[u8],
    secret_key: &elements::bitcoin::secp256k1::SecretKey,
) -> anyhow::Result<String> {
    let secp = elements::bitcoin::secp256k1::Secp256k1::new();
    let public_key = secret_key.public_key(&secp);
    let challenge = ScriptBuf::new_p2wpkh(&CompressedPublicKey(public_key).wpubkey_hash());
    let to_spend = bip322_to_spend(message, challenge.clone())?;
    let mut to_sign = bip322_to_sign(to_spend.compute_txid());
    let sighash = SighashCache::new(&to_sign).p2wpkh_signature_hash(
        0,
        &challenge,
        Amount::ZERO,
        EcdsaSighashType::All,
    )?;
    let signature = secp.sign_ecdsa(
        &elements::bitcoin::secp256k1::Message::from_digest(sighash.to_byte_array()),
        secret_key,
    );
    let signature = elements::bitcoin::ecdsa::Signature::sighash_all(signature);
    to_sign.input[0].witness = Witness::p2wpkh(&signature, &public_key);
    Ok(format!(
        "smp{}",
        BASE64_STANDARD.encode(serialize(&to_sign.input[0].witness))
    ))
}

fn verify_bip322_simple(
    message: &[u8],
    proof_address: &str,
    signature: &str,
    expected_xonly: &str,
    network: Network,
) -> anyhow::Result<bool> {
    let encoded = signature
        .strip_prefix("smp")
        .context("BIP322 signature is missing the smp prefix")?;
    let witness: Witness = deserialize(&BASE64_STANDARD.decode(encoded)?)?;
    if witness.len() != 2 {
        return Ok(false);
    }
    let signature = match elements::bitcoin::ecdsa::Signature::from_slice(&witness[0]) {
        Ok(value) if value.sighash_type == EcdsaSighashType::All => value,
        _ => return Ok(false),
    };
    let public_key = match elements::bitcoin::secp256k1::PublicKey::from_slice(&witness[1]) {
        Ok(value) if witness[1].len() == 33 => value,
        _ => return Ok(false),
    };
    if public_key.x_only_public_key().0.to_string() != expected_xonly {
        return Ok(false);
    }
    let address = BitcoinAddress::from_str(proof_address)?.require_network(network)?;
    let challenge = ScriptBuf::new_p2wpkh(&CompressedPublicKey(public_key).wpubkey_hash());
    if address.script_pubkey() != challenge {
        return Ok(false);
    }
    let to_spend = bip322_to_spend(message, challenge.clone())?;
    let to_sign = bip322_to_sign(to_spend.compute_txid());
    let sighash = SighashCache::new(&to_sign).p2wpkh_signature_hash(
        0,
        &challenge,
        Amount::ZERO,
        EcdsaSighashType::All,
    )?;
    Ok(elements::bitcoin::secp256k1::Secp256k1::verification_only()
        .verify_ecdsa(
            &elements::bitcoin::secp256k1::Message::from_digest(sighash.to_byte_array()),
            &signature.signature,
            &public_key,
        )
        .is_ok())
}

fn bip322_to_spend(message: &[u8], challenge: ScriptBuf) -> anyhow::Result<Transaction> {
    let tag = sha256::Hash::hash(b"BIP0322-signed-message");
    let mut engine = sha256::Hash::engine();
    engine.input(tag.as_ref());
    engine.input(tag.as_ref());
    engine.input(message);
    let message_hash = sha256::Hash::from_engine(engine);
    let push = PushBytesBuf::try_from(message_hash.to_byte_array().to_vec())?;
    Ok(Transaction {
        version: Version::non_standard(0),
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::null(),
            script_sig: Builder::new().push_int(0).push_slice(push).into_script(),
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: challenge,
        }],
    })
}

fn bip322_to_sign(previous_txid: elements::bitcoin::Txid) -> Transaction {
    Transaction {
        version: Version::non_standard(0),
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::new(previous_txid, 0),
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: Builder::new().push_opcode(OP_RETURN).into_script(),
        }],
    }
}
