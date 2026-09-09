use damp_core::ledger::XOnlyKey;
use elements::hashes::{Hash, sha256};
use elements::secp256k1_zkp::{Error, Message, Secp256k1, schnorr::Signature};

pub(crate) const REPORT_SIGNATURE_DOMAIN: &[u8] = b"DAMP/audit/report-signature/v2\0";

pub(crate) fn digest(text: &str) -> [u8; 32] {
    let mut bytes = REPORT_SIGNATURE_DOMAIN.to_vec();
    bytes.extend_from_slice(text.as_bytes());
    sha256::Hash::hash(&bytes).to_byte_array()
}

/// Verify the exact report bytes against an independently trusted public key.
///
/// # Errors
/// Returns the curve library's verification error for a mismatched signature.
pub fn verify_report(text: &str, signature: &Signature, key: XOnlyKey) -> Result<(), Error> {
    Secp256k1::verification_only()
        .verify_schnorr(
            signature,
            &Message::from_digest(digest(text)),
            &key.public_key(),
        )
        .map_err(Into::into)
}
