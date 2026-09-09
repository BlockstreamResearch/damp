use simplicity_damp_core::ledger::{Outpoint, Txid};
use simplicity_damp_core::policy::{
    NonMembershipProof, PolicyError, PolicyKey, PolicySet, SUPPORTED_DEPTHS, SetCommitment,
    TreeDepth,
    wire::{CommitmentFields, NonMembershipFields},
};

fn key(byte: u8) -> PolicyKey {
    [byte; 32].into()
}
fn fields(proof: &NonMembershipProof) -> NonMembershipFields {
    serde_json::from_value(serde_json::to_value(proof).unwrap()).unwrap()
}

#[test]
fn every_depth_proves_boundaries_and_interior() -> Result<(), Box<dyn std::error::Error>> {
    for depth in SUPPORTED_DEPTHS {
        let set = PolicySet::new(depth, [key(0x20), key(0x40), key(0x60)])?;
        for target in [key(0x10), key(0x50), key(0x70)] {
            let proof = set.non_membership_proof(target)?;
            proof.check_scope(set.commitment(), target)?;
            assert_eq!(
                NonMembershipProof::verify(set.commitment(), target, fields(&proof))?,
                proof
            );
            for neighbor in [proof.lower(), proof.upper()].into_iter().flatten() {
                assert_eq!(neighbor.path().len(), usize::from(depth.as_u8()));
            }
        }
        assert_eq!(
            set.non_membership_proof(key(0x40)),
            Err(PolicyError::Blacklisted)
        );
        let empty = PolicySet::new(depth, [])?;
        let proof = empty.non_membership_proof(key(1))?;
        assert!(proof.lower().is_none() && proof.upper().is_none());
    }
    Ok(())
}

#[test]
fn capacity_duplicate_and_depth_rules_are_constructor_invariants() {
    for depth in SUPPORTED_DEPTHS {
        assert_eq!(
            PolicySet::new(depth, (0..depth.capacity()).map(|index| key(index as u8)))
                .unwrap()
                .len(),
            depth.capacity()
        );
        assert_eq!(
            PolicySet::new(depth, std::iter::repeat(key(1))),
            Err(PolicyError::Capacity(depth))
        );
        assert_eq!(
            PolicySet::new(depth, [key(1), key(1)]),
            Err(PolicyError::Duplicate)
        );
        let empty = PolicySet::new(depth, []).unwrap().commitment();
        assert!(SetCommitment::new(depth, empty.root(), depth.capacity() as u32 + 1).is_err());
        let invalid = CommitmentFields {
            depth,
            root: empty.root(),
            count: depth.capacity() as u32 + 1,
        };
        assert!(
            serde_json::from_value::<SetCommitment>(serde_json::to_value(invalid).unwrap())
                .is_err()
        );
        assert!(SetCommitment::new(depth, [0; 32].into(), 0).is_err());
    }
    assert_eq!(TreeDepth::smallest_for_len(16), Ok(TreeDepth::D4));
    assert_eq!(TreeDepth::smallest_for_len(17), Ok(TreeDepth::D5));
    assert_eq!(TreeDepth::smallest_for_len(33), Ok(TreeDepth::D6));
    assert!(TreeDepth::smallest_for_len(65).is_err());
    for invalid in [0, 3, 7, 255, 260] {
        assert!(serde_json::from_value::<TreeDepth>(serde_json::json!(invalid)).is_err());
    }
}

#[test]
fn malformed_paths_boundaries_indexes_and_roots_are_rejected()
-> Result<(), Box<dyn std::error::Error>> {
    for depth in SUPPORTED_DEPTHS {
        let set = PolicySet::new(depth, [key(0x20), key(0x40)])?;
        let target = key(0x30);
        let original = fields(&set.non_membership_proof(target)?);
        let mut mutations = Vec::new();
        let mut value = original.clone();
        value.lower.as_mut().unwrap().path.pop();
        mutations.push(value);
        let mut value = original.clone();
        value.lower.as_mut().unwrap().path[0] = [0xff; 32].into();
        mutations.push(value);
        let mut value = original.clone();
        value.lower.as_mut().unwrap().index = 2;
        mutations.push(value);
        let mut value = original.clone();
        value.upper.as_mut().unwrap().index += 1;
        mutations.push(value);
        let mut value = original.clone();
        value.insertion_index = 3;
        mutations.push(value);
        let mut value = original.clone();
        value.lower = None;
        mutations.push(value);
        let mut value = original.clone();
        value.upper = None;
        mutations.push(value);
        let mut value = original.clone();
        value.lower.as_mut().unwrap().key = key(0x50);
        mutations.push(value);
        let mut value = original.clone();
        value.upper.as_mut().unwrap().key = key(0x10);
        mutations.push(value);
        for invalid in mutations {
            assert!(NonMembershipProof::verify(set.commitment(), target, invalid).is_err());
        }
        assert!(NonMembershipProof::verify(set.commitment(), key(0x20), original.clone()).is_err());
        let wrong_root = SetCommitment::new(depth, [0xff; 32].into(), 2)?;
        assert!(NonMembershipProof::verify(wrong_root, target, original).is_err());
    }
    Ok(())
}

#[test]
fn verified_proofs_cannot_be_reused_for_another_policy_or_key()
-> Result<(), Box<dyn std::error::Error>> {
    let set = PolicySet::new(TreeDepth::D4, [key(0x20)])?;
    let target = key(0x30);
    let proof = set.non_membership_proof(target)?;
    let another = PolicySet::new(TreeDepth::D4, [key(0x20), key(0x40)])?;
    assert_eq!(
        proof.check_scope(another.commitment(), target),
        Err(PolicyError::ProofScope)
    );
    assert_eq!(
        proof.check_scope(set.commitment(), key(0x31)),
        Err(PolicyError::ProofScope)
    );
    Ok(())
}

#[test]
fn proof_fields_require_explicit_nullable_neighbors() {
    let proof = PolicySet::new(TreeDepth::D4, [])
        .unwrap()
        .non_membership_proof(key(1))
        .unwrap();
    let value = serde_json::to_value(proof).unwrap();
    assert!(serde_json::from_value::<NonMembershipFields>(value.clone()).is_ok());
    for field in ["lower", "upper"] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<NonMembershipFields>(missing).is_err());
    }
}

#[test]
fn outpoint_keys_use_consensus_transaction_order_and_big_endian_index() {
    use sha2::{Digest, Sha256};
    let mut display = [0; 32];
    display[0] = 1;
    let outpoint = Outpoint::new(Txid::from(display), 7);
    let mut consensus = display;
    consensus.reverse();
    let mut hasher = Sha256::new();
    hasher.update(consensus);
    hasher.update(7u32.to_be_bytes());
    assert_eq!(
        PolicyKey::for_outpoint(outpoint).to_byte_array(),
        <[u8; 32]>::from(hasher.finalize())
    );
}

#[test]
fn policy_roots_match_shared_wasm_vectors_and_empty_contract_roots()
-> Result<(), Box<dyn std::error::Error>> {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/policy-vectors.json"))?;
    for vector in vectors.as_array().unwrap() {
        let depth: TreeDepth = serde_json::from_value(vector["treeDepth"].clone())?;
        let set = PolicySet::new(depth, [])?;
        assert_eq!(set.root().to_string(), vector["setRoot"].as_str().unwrap());
        assert_eq!(
            set.commitment().policy_digest().to_string(),
            vector["policyRoot"].as_str().unwrap()
        );
        assert_eq!(
            u64::from(set.commitment().count()),
            vector["entryCount"].as_u64().unwrap()
        );
    }
    Ok(())
}
