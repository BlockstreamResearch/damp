use rand::{SeedableRng, rngs::StdRng};
use secp256k1_zkp::{PublicKey, Secp256k1, SecretKey, Tweak, ZERO_TWEAK};
use sha2::{Digest, Sha256};
use simplicity_damp_core::{
    ledger::{AssetId, AuditAmount},
    native_audit::{
        AuditDomain, AuditError, AuditOpening, AuditOutput, AuditStatement, AuxiliaryRecord,
        MAX_NATIVE_AUDIT_VALUE, NativeAuditAmount, NativeAuditProof, RecoveryBound,
    },
    registry::{AuditEpoch, DeploymentSalt, NativeAuditConfig},
};

fn domain(secret: &SecretKey) -> AuditDomain {
    AuditDomain::new(
        DeploymentSalt::try_from([42; 32]).unwrap(),
        NativeAuditConfig {
            public_key: PublicKey::from_secret_key(&Secp256k1::new(), secret).into(),
            epoch: AuditEpoch::INITIAL,
        },
    )
}

fn fixture(value: u64) -> (AuditOpening, SecretKey, AuditStatement) {
    let opening = AuditOpening::new(
        value.try_into().unwrap(),
        Tweak::from_inner([7; 32]).unwrap(),
    )
    .unwrap();
    let secret = SecretKey::from_slice(&[9; 32]).unwrap();
    let domain = domain(&secret);
    let asset = AssetId::from_consensus_byte_array(std::array::from_fn(|index| index as u8));
    let output =
        AuditOutput::new(2, asset, opening.commitment(asset).unwrap(), [4; 32].into()).unwrap();
    let auxiliary = output
        .seal(&mut rand::thread_rng(), domain, &opening)
        .unwrap();
    let statement = AuditStatement::new(domain, output, [3; 32].into(), auxiliary);
    (opening, secret, statement)
}

fn bytes<const N: usize>(vector: &serde_json::Value, key: &str) -> [u8; N] {
    hex::decode(vector[key].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}
fn tagged_hash(tag: &[u8], bytes: &[u8]) -> [u8; 32] {
    let tag = Sha256::digest(tag);
    let mut hasher = Sha256::new();
    hasher.update(tag);
    hasher.update(tag);
    hasher.update(bytes);
    hasher.finalize().into()
}

#[test]
fn seeded_bytes_match_the_proof_recovery_and_transcript_fixture() {
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/native-audit-vector.json")).unwrap();
    let mut rng = StdRng::seed_from_u64(vector["seed"].as_u64().unwrap());
    let opening = AuditOpening::new(
        vector["value"].as_str().unwrap().parse().unwrap(),
        Tweak::from_inner(bytes(&vector, "blinder")).unwrap(),
    )
    .unwrap();
    let secret = SecretKey::from_slice(&bytes::<32>(&vector, "auditSecret")).unwrap();
    let domain = AuditDomain::new(
        DeploymentSalt::try_from(bytes::<32>(&vector, "deployment")).unwrap(),
        NativeAuditConfig {
            public_key: PublicKey::from_secret_key(&Secp256k1::new(), &secret).into(),
            epoch: vector["epoch"].as_u64().unwrap().try_into().unwrap(),
        },
    );
    let asset = AssetId::from_consensus_byte_array(bytes(&vector, "assetConsensus"));
    assert_ne!(asset.to_byte_array(), asset.to_consensus_byte_array());
    let commitment = opening.commitment(asset).unwrap();
    assert_eq!(commitment.serialize(), bytes::<33>(&vector, "commitment"));
    let output = AuditOutput::new(
        vector["outputIndex"].as_u64().unwrap().try_into().unwrap(),
        asset,
        commitment,
        bytes::<32>(&vector, "scriptHash").into(),
    )
    .unwrap();
    let auxiliary = output.seal(&mut rng, domain, &opening).unwrap();
    assert_eq!(
        auxiliary.to_byte_array(),
        bytes::<102>(&vector, "auxiliary")
    );
    let statement = AuditStatement::new(
        domain,
        output,
        bytes::<32>(&vector, "sigAllHash").into(),
        auxiliary,
    );
    let verified = NativeAuditProof::prove(&mut rng, &statement, &opening).unwrap();
    let proof = verified.proof();
    assert_eq!(proof.encode(), bytes::<196>(&vector, "proof"));
    assert_eq!(&NativeAuditProof::decode(&proof.encode()).unwrap(), proof);
    assert_eq!(
        verified
            .open_recovery(&domain.bind_secret(&secret).unwrap())
            .unwrap()
            .value()
            .get(),
        65535
    );

    let mut context = Vec::new();
    context.extend(domain.deployment().to_byte_array());
    context.extend(domain.epoch().get().to_be_bytes());
    context.extend(output.index().to_be_bytes());
    context.extend(asset.to_consensus_byte_array());
    context.extend(commitment.serialize());
    context.extend(output.script_hash().to_byte_array());
    assert_eq!(
        tagged_hash(b"DAMP/audit/recovery-context/v2", &context),
        bytes::<32>(&vector, "context")
    );

    let mut transcript = Vec::new();
    transcript.extend(domain.deployment().to_byte_array());
    transcript.extend(2u32.to_be_bytes());
    transcript.extend(domain.epoch().get().to_be_bytes());
    transcript.extend(domain.key().to_byte_array());
    transcript.extend(statement.sig_all_hash().to_byte_array());
    transcript.extend(output.index().to_be_bytes());
    transcript.extend(asset.to_consensus_byte_array());
    transcript.extend(commitment.serialize());
    transcript.extend(output.script_hash().to_byte_array());
    transcript.push(0);
    transcript.extend(Sha256::digest(auxiliary.as_ref()));
    transcript.extend(proof.handle().serialize());
    transcript.extend(proof.commitment_nonce().serialize());
    transcript.extend(proof.handle_nonce().serialize());
    assert_eq!(
        tagged_hash(b"DAMP/audit/autonomous/v3", &transcript),
        bytes::<32>(&vector, "challengeDigest")
    );
}

#[test]
fn native_proof_and_authenticated_recovery_accept_application_boundaries() {
    for value in [
        1,
        2,
        65535,
        1 << 32,
        (1 << 62) - 1,
        1 << 62,
        AuditAmount::MAX - 1,
        AuditAmount::MAX,
    ] {
        let (opening, secret, statement) = fixture(value);
        let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &statement, &opening).unwrap();
        let key = statement.domain().bind_secret(&secret).unwrap();
        assert_eq!(proof.open_recovery(&key).unwrap().value().get(), value);
        let second =
            NativeAuditProof::prove(&mut rand::thread_rng(), &statement, &opening).unwrap();
        assert_ne!(
            proof.proof().commitment_nonce(),
            second.proof().commitment_nonce()
        );
    }
    assert!(AuditAmount::try_from(0).is_err());
    assert!(AuditAmount::try_from(MAX_NATIVE_AUDIT_VALUE).is_err());
    assert!(AuditOpening::new(1.try_into().unwrap(), ZERO_TWEAK).is_err());
    assert!(NativeAuditAmount::try_from(0).is_err());
    assert!(NativeAuditAmount::try_from(MAX_NATIVE_AUDIT_VALUE + 1).is_err());
    assert!(
        NativeAuditAmount::try_from(MAX_NATIVE_AUDIT_VALUE)
            .unwrap()
            .application_amount()
            .is_none()
    );
    for text in ["0", "01", " 1", "9223372036854775809"] {
        assert!(serde_json::from_value::<NativeAuditAmount>(serde_json::json!(text)).is_err());
    }
}

#[test]
fn proof_is_bound_to_every_statement_field_and_native_sign() {
    let (opening, _, statement) = fixture(999);
    let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &statement, &opening)
        .unwrap()
        .into_proof();
    for kind in 0..8 {
        let old_domain = statement.domain();
        let old_output = statement.output();
        let mut domain = old_domain;
        let mut output = old_output;
        let mut sighash = statement.sig_all_hash();
        let mut auxiliary = statement.auxiliary();
        match kind {
            0 => {
                output = AuditOutput::new(
                    3,
                    old_output.asset(),
                    old_output.commitment(),
                    old_output.script_hash(),
                )
                .unwrap()
            }
            1 => {
                domain = AuditDomain::new(
                    old_domain.deployment(),
                    NativeAuditConfig {
                        public_key: old_domain.key(),
                        epoch: 2.try_into().unwrap(),
                    },
                )
            }
            2 => {
                domain = AuditDomain::new(
                    DeploymentSalt::try_from([43; 32]).unwrap(),
                    NativeAuditConfig {
                        public_key: old_domain.key(),
                        epoch: old_domain.epoch(),
                    },
                )
            }
            3 => sighash = [5; 32].into(),
            4 => {
                output = AuditOutput::new(
                    old_output.index(),
                    AssetId::from_byte_array([18; 32]),
                    old_output.commitment(),
                    old_output.script_hash(),
                )
                .unwrap()
            }
            5 => {
                output = AuditOutput::new(
                    old_output.index(),
                    old_output.asset(),
                    old_output.commitment(),
                    [5; 32].into(),
                )
                .unwrap()
            }
            6 => {
                let mut bytes = auxiliary.to_byte_array();
                bytes[90] ^= 1;
                auxiliary = AuxiliaryRecord::from_byte_array(bytes);
            }
            _ => domain = self::domain(&SecretKey::from_slice(&[6; 32]).unwrap()),
        }
        assert!(
            proof
                .verify(&AuditStatement::new(domain, output, sighash, auxiliary))
                .is_err(),
            "field {kind}"
        );
    }
    let mut changed = proof.encode();
    changed[0] ^= 1;
    assert!(matches!(
        NativeAuditProof::decode(&changed)
            .unwrap()
            .verify(&statement),
        Err(AuditError::Parity)
    ));
    let mut changed = proof.encode();
    changed[32] ^= 1;
    assert!(matches!(
        NativeAuditProof::decode(&changed)
            .unwrap()
            .verify(&statement),
        Err(AuditError::Root)
    ));
}

#[test]
fn unavailable_auxiliary_does_not_veto_a_proof_or_authorize_another_key() {
    let (opening, secret, statement) = fixture(999);
    let key = statement.domain().bind_secret(&secret).unwrap();
    let wrong = SecretKey::from_slice(&[8; 32]).unwrap();
    assert!(statement.domain().bind_secret(&wrong).is_err());
    let mut invalid = statement.auxiliary().to_byte_array();
    invalid[90] ^= 1;
    for auxiliary in [
        AuxiliaryRecord::MISSING,
        AuxiliaryRecord::from_byte_array(invalid),
    ] {
        let changed = AuditStatement::new(
            statement.domain(),
            statement.output(),
            statement.sig_all_hash(),
            auxiliary,
        );
        let proof = NativeAuditProof::prove(&mut rand::thread_rng(), &changed, &opening).unwrap();
        assert!(proof.open_recovery(&key).is_err());
        assert_eq!(
            proof
                .recover_bounded(&key, 1024.try_into().unwrap())
                .unwrap()
                .unwrap()
                .get(),
            999
        );
        assert!(
            proof
                .recover_bounded(&key, 998.try_into().unwrap())
                .unwrap()
                .is_none()
        );
        let other_epoch = AuditDomain::new(
            statement.domain().deployment(),
            NativeAuditConfig {
                public_key: statement.domain().key(),
                epoch: 2.try_into().unwrap(),
            },
        );
        let other_key = other_epoch.bind_secret(&secret).unwrap();
        assert!(matches!(
            proof.open_recovery(&other_key),
            Err(AuditError::AuditKey)
        ));
        assert!(matches!(
            proof.recover_bounded(&other_key, 1.try_into().unwrap()),
            Err(AuditError::AuditKey)
        ));
    }
    assert!(RecoveryBound::try_from(0).is_err());
    assert!(RecoveryBound::try_from(RecoveryBound::MAX + 1).is_err());
    assert_eq!(
        RecoveryBound::try_from(RecoveryBound::MAX).unwrap().get(),
        1 << 32
    );
    assert!(serde_json::from_value::<RecoveryBound>(serde_json::json!(0)).is_err());
}

#[test]
fn construction_checks_opening_context_and_redacts_secrets() {
    let (opening, secret, statement) = fixture(999);
    let other = AuditOpening::new(
        1000.try_into().unwrap(),
        Tweak::from_inner([7; 32]).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        NativeAuditProof::prove(&mut rand::thread_rng(), &statement, &other),
        Err(AuditError::CommitmentMismatch)
    ));
    assert!(matches!(
        statement
            .output()
            .seal(&mut rand::thread_rng(), statement.domain(), &other),
        Err(AuditError::CommitmentMismatch)
    ));
    assert!(
        AuditOutput::new(
            0,
            statement.output().asset(),
            statement.output().commitment(),
            statement.output().script_hash()
        )
        .is_err()
    );
    assert_eq!(format!("{opening:?}"), "AuditOpening([REDACTED])");
    assert!(
        !format!("{:?}", statement.domain().bind_secret(&secret).unwrap())
            .contains(&"09".repeat(32))
    );
}
