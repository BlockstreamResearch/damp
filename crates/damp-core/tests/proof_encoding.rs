use secp256k1_zkp::{PublicKey, Secp256k1, SecretKey};
use simplicity_damp_core::native_audit::{NativeAuditProof, ProofEncodingError};

#[test]
fn parts_constructor_rejects_noncanonical_scalars_and_roots() {
    let key =
        PublicKey::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&[1; 32]).unwrap());
    assert_eq!(
        NativeAuditProof::from_parts(false, [0; 32], key, key, key, [255; 32], [0; 32]),
        Err(ProofEncodingError::Scalar)
    );
    assert_eq!(
        NativeAuditProof::from_parts(false, [0; 32], key, key, key, [0; 32], [255; 32]),
        Err(ProofEncodingError::Scalar)
    );
    assert_eq!(
        NativeAuditProof::from_parts(false, [255; 32], key, key, key, [0; 32], [0; 32]),
        Err(ProofEncodingError::Root)
    );
    let proof =
        NativeAuditProof::from_parts(false, [0; 32], key, key, key, [0; 32], [0; 32]).unwrap();
    assert_eq!(NativeAuditProof::decode(&proof.encode()).unwrap(), proof);
}

#[test]
fn encoding_shape_is_checked_before_accessing_fields() {
    assert_eq!(
        NativeAuditProof::decode(&[]),
        Err(ProofEncodingError::Length)
    );
    assert_eq!(
        NativeAuditProof::decode(&[0; 195]),
        Err(ProofEncodingError::Length)
    );
    assert_eq!(
        NativeAuditProof::decode(&[2; 196]),
        Err(ProofEncodingError::Parity)
    );
}
