//! Positive-minimum boundary proof; still not a full consensus transaction test.
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
    let script = [0x51];
    let mut rows = Vec::new();
    for (value, minimum, bits, exponent) in [
        (1, 1, 0, 0),
        (i64::MAX as u64, 1, 63, 0),
        ((i64::MAX as u64) + 1, 1, 63, 0),
        (u64::MAX, 1u64 << 63, 63, 0),
        (u64::MAX, u64::MAX, 0, -1),
    ] {
        let commitment = PedersenCommitment::new(&secp, value, blind, generator);
        let proof = RangeProof::new(
            &secp,
            minimum,
            commitment,
            value,
            blind,
            &[],
            &script,
            nonce,
            exponent,
            bits,
            generator,
        );
        let proof = match proof {
            Ok(proof) => proof,
            Err(error) => {
                rows.push(serde_json::json!({"value":value.to_string(),"requested_minimum":minimum.to_string(),"exponent":exponent,"constructed":false,"error":error.to_string()}));
                continue;
            }
        };
        let range =
            range_inclusive::verify(&secp, &proof.serialize(), commitment, &script, generator)
                .unwrap();
        assert!(*range.start() > 0 && range.contains(&value));
        assert!(
            range_inclusive::verify(&secp, &proof.serialize(), commitment, &[0x52], generator)
                .is_err()
        );
        rows.push(serde_json::json!({"constructed":true,"reveals_exact_value":exponent == -1,"value":value.to_string(),"minimum":range.start().to_string(),"maximum":range.end().to_string(),"proof_bytes":proof.len(),"positive_minimum":true,"wrong_script_rejected":true}));
    }
    println!("{}", serde_json::to_string_pretty(&rows).unwrap());
}
