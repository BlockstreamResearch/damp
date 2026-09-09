use damp_core::{
    ledger::Outpoint,
    native_audit::{AuditOutput, AuditStatement},
};
use elements::{
    hashes::{Hash, sha256},
    pset::PartiallySignedTransaction,
    secp256k1_zkp::SecretKey,
};
use lwk_signer::SwSigner;

use super::{
    AuxiliaryFailure, RecoveredOutput, RecoveryError, RecoveryOutcome, RecoveryRequest,
    RecoveryResult, witness,
};
use crate::{
    covenant::policy::protocol_for_deployment,
    keys::{self, KeyRole},
};

pub(crate) fn recover(
    signer: &SwSigner,
    request: &RecoveryRequest,
) -> Result<RecoveryResult, RecoveryError> {
    let index = keys::derive_key_index(&request.deployment().deployment_salt(), KeyRole::Audit)
        .map_err(RecoveryError::KeyDerivation)?;
    let (_, key) =
        keys::derive_xprv(signer, KeyRole::Audit, index).map_err(RecoveryError::KeyDerivation)?;
    recover_key(&key.secret_key(), request)
}

pub(crate) fn recover_key(
    secret: &SecretKey,
    request: &RecoveryRequest,
) -> Result<RecoveryResult, RecoveryError> {
    let protocol = protocol_for_deployment(request.deployment())
        .map_err(RecoveryError::VerifierConstruction)?;
    let parameters = protocol.audit();
    let secret = parameters.bind_secret(secret)?;
    let transaction = request.transaction();
    let tx = transaction.transaction();
    let mut pset = PartiallySignedTransaction::from_tx(tx.clone());
    for (input, spent) in pset.inputs_mut().iter_mut().zip(request.spent_outputs()) {
        input.witness_utxo = Some(spent.clone());
    }
    let anchor = protocol
        .anchor(request.policy().tree().commitment())
        .map_err(RecoveryError::VerifierConstruction)?;
    let (program, sighash) = anchor
        .verify_transfer_witness(&pset, request.deployment().network())
        .map_err(RecoveryError::CovenantVerification)?;
    let mut rows = Vec::new();
    for record in witness::records(&program)? {
        let index = record.index;
        let output = tx
            .output
            .get(index as usize)
            .ok_or(RecoveryError::OutputIndex(index))?;
        let range = output
            .witness
            .rangeproof
            .as_deref()
            .ok_or(RecoveryError::RangeProof(index))?
            .serialize();
        if range.len() != witness::RANGE_HEADER.len() + witness::RANGE_BODY_BYTES
            || range[..10] != witness::RANGE_HEADER
            || range[10..] != record.range_body
        {
            return Err(RecoveryError::RangeProof(index));
        }
        let statement = AuditStatement::new(
            parameters,
            AuditOutput::new(
                index,
                request.deployment().regulated_asset(),
                output
                    .value
                    .commitment()
                    .ok_or(RecoveryError::ExplicitValue(index))?,
                sha256::Hash::hash(output.script_pubkey.as_bytes())
                    .to_byte_array()
                    .into(),
            )?,
            sighash.into(),
            record.auxiliary,
        );
        let verified = record.proof.verify(&statement)?;
        let outcome = match verified.open_recovery(&secret) {
            Ok(opening) => RecoveryOutcome::Authenticated {
                amount: opening.value(),
            },
            Err(_) => {
                let auxiliary = if record.auxiliary.is_missing() {
                    AuxiliaryFailure::Missing
                } else {
                    AuxiliaryFailure::Invalid
                };
                match request.dlp_upper_bound() {
                    Some(bound) => match verified.recover_bounded(&secret, bound)? {
                        Some(amount) => RecoveryOutcome::Bounded { amount, auxiliary },
                        None => RecoveryOutcome::Exhausted { auxiliary },
                    },
                    None => RecoveryOutcome::Unavailable { auxiliary },
                }
            }
        };
        rows.push(RecoveredOutput::new(
            Outpoint::new(transaction.txid(), index),
            outcome,
            output.script_pubkey.as_bytes().to_vec().try_into()?,
        ));
    }
    Ok(RecoveryResult::new(transaction.txid(), rows))
}
