mod support;

use damp_core::{
    ledger::ConsensusTxid,
    native_audit::{AuditError, MAX_NATIVE_AUDIT_VALUE, RecoveryBound},
    registry::{AssetMetadata, DeploymentManifest, PolicySnapshot, SupplyMode},
};
use elements::{AssetId, LockTime, OutPoint, Script, Transaction, TxIn, TxOut, hashes::Hash as _};
use simplicity_damp_signer::{
    Error, Signer,
    audit::{
        ApplicationBounds, AuxiliaryFailure, AuxiliaryStatus, RecoveryError, RecoveryOutcome,
        RecoveryRequest, RecoveryStatus,
    },
    keys::{HolderKeyLocator, KeyIndex, WalletBranch, WalletKeyLocator},
    network::DeploymentNetwork,
    ops::request::{BootstrapRequest, TransferRequest},
    transaction::{TransactionEncodingError, TransactionRecord},
    wire::{Operation, execute_native},
};
use support::{MNEMONIC, confidential_funding_utxo, funding_utxo, parent_utxo, public_asset};

fn manifests() -> (DeploymentManifest, PolicySnapshot) {
    (
        serde_json::from_str(include_str!(
            "../../../registry/fixtures/deployment.valid.json"
        ))
        .unwrap(),
        serde_json::from_str(include_str!("../../../registry/fixtures/policy.valid.json")).unwrap(),
    )
}
fn parent(version: u32) -> TransactionRecord {
    TransactionRecord::new(Transaction {
        version,
        lock_time: LockTime::ZERO,
        input: Vec::new(),
        output: vec![TxOut {
            script_pubkey: Script::from(vec![0x51]),
            ..TxOut::default()
        }],
    })
    .unwrap()
}
fn child(parent: &TransactionRecord, index: u32) -> TransactionRecord {
    TransactionRecord::new(Transaction {
        version: 2,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::new(parent.transaction().txid(), index),
            ..TxIn::default()
        }],
        output: Vec::new(),
    })
    .unwrap()
}

#[test]
fn transaction_parsing_is_canonical_bounded_and_retains_native_identity() {
    let record = parent(2);
    let text = record.to_string();
    let parsed: TransactionRecord = text.parse().unwrap();
    assert_eq!(parsed, record);
    assert_eq!(
        parsed.txid(),
        ConsensusTxid::from(record.transaction().txid().to_byte_array()).into()
    );
    assert_eq!(parsed.encoded_size(), text.len() / 2);
    assert_eq!(
        serde_json::to_value(&parsed).unwrap(),
        serde_json::json!(text)
    );
    for text in ["", "0", "0X00", "0A", "no", "0000"] {
        assert!(text.parse::<TransactionRecord>().is_err());
        assert!(serde_json::from_value::<TransactionRecord>(serde_json::json!(text)).is_err());
    }
    let mut large = record.into_transaction();
    large.output[0].script_pubkey = Script::from(vec![0; TransactionRecord::MAX_ENCODED_BYTES + 1]);
    assert!(matches!(
        TransactionRecord::new(large),
        Err(TransactionEncodingError::Size { .. })
    ));
    assert!(matches!(
        "00".repeat(TransactionRecord::MAX_ENCODED_BYTES + 1)
            .parse::<TransactionRecord>(),
        Err(TransactionEncodingError::Size { .. })
    ));
}

#[test]
fn recovery_requests_resolve_parent_and_scope_invariants_before_execution() {
    let (deployment, policy) = manifests();
    let parent = parent(2);
    let tx = child(&parent, 0);
    let make =
        |tx, parents| RecoveryRequest::new(deployment.clone(), policy.clone(), tx, parents, None);
    let valid = make(tx.clone(), vec![parent.clone()]).unwrap();
    assert_eq!(valid.transaction(), &tx);
    assert_eq!(valid.spent_outputs(), parent.transaction().output);
    assert!(matches!(
        make(tx.clone(), Vec::new()),
        Err(RecoveryError::MissingParent(_))
    ));
    assert!(matches!(
        make(tx.clone(), vec![parent.clone(), parent.clone()]),
        Err(RecoveryError::DuplicateParent(_))
    ));
    assert!(matches!(
        make(child(&parent, 1), vec![parent.clone()]),
        Err(RecoveryError::ParentOutput(_))
    ));
    let many = (0..=RecoveryRequest::MAX_PARENTS).map(|index| self::parent(index as u32));
    assert!(matches!(
        RecoveryRequest::new(deployment.clone(), policy.clone(), tx.clone(), many, None),
        Err(RecoveryError::ParentCount)
    ));
    let mut foreign: damp_core::registry::wire::SnapshotFields = policy.clone().into();
    foreign.deployment_id = [99; 32].into();
    assert!(matches!(
        RecoveryRequest::new(
            deployment.clone(),
            foreign.try_into().unwrap(),
            tx.clone(),
            [parent.clone()],
            None
        ),
        Err(RecoveryError::PolicyDeployment)
    ));
    let mut large = parent.transaction().clone();
    large.output[0].script_pubkey =
        Script::from(vec![0; RecoveryRequest::MAX_TRANSACTION_BYTES + 1]);
    assert!(matches!(
        make(TransactionRecord::new(large).unwrap(), Vec::new()),
        Err(RecoveryError::TransactionSize)
    ));
    let fields = serde_json::json!({ "deployment": deployment, "policy": policy, "transaction": tx,
        "previousTransactions": [parent], "dlpUpperBound": 0 });
    let parsed: RecoveryRequest = serde_json::from_value(fields.clone()).unwrap();
    assert_eq!(parsed, valid);
    assert_eq!(parsed.dlp_upper_bound(), None);
    for (field, value) in [
        ("dlpUpperBound", serde_json::json!(RecoveryBound::MAX + 1)),
        ("previousTransactions", serde_json::json!([])),
        (
            "previousTransactions",
            serde_json::json!(vec![fields["previousTransactions"][0].clone(); 257]),
        ),
    ] {
        let mut invalid = fields.clone();
        invalid[field] = value;
        assert!(serde_json::from_value::<RecoveryRequest>(invalid.clone()).is_err());
        assert!(Operation::parse("recover-audit", invalid).is_err());
    }
}

#[test]
fn recovery_outcomes_keep_availability_and_application_bounds_distinct() {
    let amount = 999.try_into().unwrap();
    let recovered = RecoveryOutcome::Authenticated { amount };
    assert_eq!(recovered.status(), RecoveryStatus::Recovered);
    assert_eq!(recovered.auxiliary_status(), AuxiliaryStatus::Valid);
    assert_eq!(
        recovered.application_bounds(),
        ApplicationBounds::WithinApplicationCap
    );
    let endpoint = RecoveryOutcome::Authenticated {
        amount: MAX_NATIVE_AUDIT_VALUE.try_into().unwrap(),
    };
    assert_eq!(
        endpoint.application_bounds(),
        ApplicationBounds::OutsideApplicationCap
    );
    for auxiliary in [AuxiliaryFailure::Missing, AuxiliaryFailure::Invalid] {
        let expected = match auxiliary {
            AuxiliaryFailure::Missing => AuxiliaryStatus::Missing,
            AuxiliaryFailure::Invalid => AuxiliaryStatus::Invalid,
        };
        for (outcome, status) in [
            (
                RecoveryOutcome::Bounded { amount, auxiliary },
                RecoveryStatus::RecoveredByBoundedDlp,
            ),
            (
                RecoveryOutcome::Exhausted { auxiliary },
                RecoveryStatus::BoundedDlpExhausted,
            ),
            (
                RecoveryOutcome::Unavailable { auxiliary },
                RecoveryStatus::RecoveryRequired,
            ),
        ] {
            assert_eq!(outcome.status(), status);
            assert_eq!(outcome.auxiliary_status(), expected);
            if status != RecoveryStatus::RecoveredByBoundedDlp {
                assert_eq!(outcome.amount(), None);
                assert_eq!(outcome.application_bounds(), ApplicationBounds::Unknown);
            }
        }
    }
    assert_eq!(
        serde_json::to_value(RecoveryStatus::RecoveredByBoundedDlp).unwrap(),
        "recovered-by-bounded-dlp"
    );
    assert_eq!(
        serde_json::to_value(RecoveryStatus::BoundedDlpExhausted).unwrap(),
        "bounded-dlp-exhausted"
    );
    assert_eq!(
        serde_json::to_value(ApplicationBounds::OutsideApplicationCap).unwrap(),
        "outside-application-cap"
    );
}

#[test]
fn native_and_json_recovery_execute_the_actual_transfer_and_return_public_fields()
-> anyhow::Result<()> {
    let network = DeploymentNetwork::ElementsRegtest;
    let signer = Signer::new(MNEMONIC, network)?;
    let asset = AssetId::from_byte_array([0xaa; 32]);
    let funding = [
        confidential_funding_utxo(&signer, network, asset, 20_000, 0)?,
        funding_utxo(&signer, network, asset, 20_000, 2, 1)?,
    ];
    let boot = signer.bootstrap(BootstrapRequest {
        network,
        policy_asset: public_asset(asset),
        deployment_salt: [0x11; 32].try_into()?,
        asset: AssetMetadata::new("DAMP Recovery".into(), "DAMPR".into(), 0)?,
        issued_supply: 1000.try_into()?,
        supply_mode: SupplyMode::IssuerManaged,
        policy_utxos: funding.to_vec(),
        fee: 4000.try_into()?,
        required_confirmations: 1,
    })?;
    let transfer = signer.transfer(TransferRequest {
        deployment: boot.deployment.clone(),
        current_policy: boot.initial_policy.clone(),
        verifier_utxo: parent_utxo(&boot.txid, 0, &boot.transaction, None, None),
        regulated_utxos: vec![parent_utxo(
            &boot.txid,
            1,
            &boot.transaction,
            None,
            Some(HolderKeyLocator {
                derivation_index: boot.holder_derivation_index,
                owner_public_key: boot.initial_holder_address.owner_public_key.parse()?,
            }),
        )],
        fee_utxos: vec![parent_utxo(
            &boot.txid,
            3,
            &boot.transaction,
            Some(WalletKeyLocator {
                branch: WalletBranch::Change,
                index: KeyIndex::ZERO,
            }),
            None,
        )],
        recipient_address: boot.initial_holder_address.confidential_address.clone(),
        amount: 600.try_into()?,
        fee: 4000.try_into()?,
    })?;
    let transaction: TransactionRecord = transfer.transaction.parse()?;
    let request = RecoveryRequest::new(
        boot.deployment.clone(),
        boot.initial_policy.clone(),
        transaction.clone(),
        [boot.transaction.parse()?],
        None,
    )?;
    let recovered = signer.recover_audit(&request)?;
    assert_eq!(recovered.transaction_id(), transaction.txid());
    assert_eq!(recovered.outputs().len(), 2);
    for (row, expected) in recovered.outputs().iter().zip([600, 400]) {
        assert_eq!(row.outcome().amount().unwrap().get(), expected);
        assert_eq!(row.outcome().status(), RecoveryStatus::Recovered);
        assert_eq!(row.outcome().auxiliary_status(), AuxiliaryStatus::Valid);
        assert_eq!(row.outpoint().txid(), transaction.txid());
    }
    let wire_request = serde_json::json!({ "deployment": boot.deployment, "policy": boot.initial_policy,
        "transaction": transaction, "previousTransactions": [boot.transaction], "dlpUpperBound": 0 });
    let wire = execute_native(MNEMONIC, network, "recover-audit", wire_request)?;
    assert_eq!(wire, serde_json::to_value(&recovered)?);
    assert_eq!(wire["covenantVerified"], true);
    assert_eq!(
        wire["chainInclusion"],
        "requires-independent-chain-verification"
    );
    let public = Signer::inspect_public_transaction(&transaction);
    assert_eq!(public.outputs[1].amount, None);
    let public_wire = execute_native(
        MNEMONIC,
        network,
        "inspect-public-transaction",
        serde_json::json!({"transaction": transaction}),
    )?;
    assert_eq!(public_wire, serde_json::to_value(public)?);
    assert_eq!(public_wire["outputs"][1]["amount"], serde_json::Value::Null);
    assert!(matches!(
        Signer::new(MNEMONIC, DeploymentNetwork::LiquidTestnet)?.recover_audit(&request),
        Err(Error::Network(_))
    ));
    let other = Signer::new(
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
        network,
    )?;
    assert!(matches!(
        other.recover_audit(&request),
        Err(Error::Recovery(RecoveryError::Native(AuditError::AuditKey)))
    ));
    let mut altered = transaction.into_transaction();
    altered.input[0].witness.script_witness[0][0] ^= 1;
    let malformed = RecoveryRequest::new(
        boot.deployment,
        boot.initial_policy,
        TransactionRecord::new(altered)?,
        [boot.transaction.parse()?],
        None,
    )?;
    assert!(matches!(
        signer.recover_audit(&malformed),
        Err(Error::Recovery(RecoveryError::CovenantVerification(_)))
    ));
    Ok(())
}
