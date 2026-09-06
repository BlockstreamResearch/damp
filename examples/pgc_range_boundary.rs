//! Probe upstream full-u64 native range-proof boundary without changing amount policy.
#[path = "support/range_inclusive.rs"]
mod range_inclusive;
use simplex::simplicityhl::elements::secp256k1_zkp::{
    Generator, PedersenCommitment, RangeProof, Secp256k1, SecretKey, Tag, Tweak,
};
fn main() {
    let secp = Secp256k1::new();
    let generator = Generator::new_unblinded(&secp, Tag::from([17; 32]));
    let blind = Tweak::from_slice(&[7; 32]).unwrap();
    let nonce = SecretKey::from_slice(&[9; 32]).unwrap();
    let mut result = Vec::new();
    for value in [1, u64::MAX] {
        let c = PedersenCommitment::new(&secp, value, blind, generator);
        let proof =
            RangeProof::new(&secp, 0, c, value, blind, &[], &[], nonce, 0, 64, generator).unwrap();
        let checked = std::panic::catch_unwind(|| proof.verify(&secp, c, &[], generator));
        let inclusive =
            range_inclusive::verify(&secp, &proof.serialize(), c, &[], generator).unwrap();
        assert!(inclusive.contains(&value));
        assert_eq!(*inclusive.end(), u64::MAX);
        let mut bad = proof.serialize();
        bad[10] ^= 1;
        assert!(range_inclusive::verify(&secp, &bad, c, &[], generator).is_err());
        assert!(
            range_inclusive::verify(&secp, &proof.serialize(), c, b"wrong script", generator)
                .is_err()
        );
        result.push(serde_json::json!({"value":value.to_string(),"proof_bytes":proof.len(),"inclusive_adapter_valid":true,"inclusive_max":inclusive.end().to_string(),"mutated_proof_and_script_rejected":true,"verify_panicked":checked.is_err(),"verify_returned_ok":checked.as_ref().is_ok_and(|r|r.is_ok()),"note":"pinned secp256k1-zkp 0.11 range API uses exclusive u64 max+1; debug overflow is caught in this research probe"}));
    }
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
