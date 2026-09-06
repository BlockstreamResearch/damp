//! Research adapter for pinned rangeproof API's exclusive-upper-bound overflow.
//! Uses public serialized inputs; never transmutes Rust wrapper layouts.
use simplex::simplicityhl::elements::secp256k1_zkp::{
    self as zkp, Generator, PedersenCommitment, Secp256k1, Verification,
};
use std::ops::RangeInclusive;
pub fn verify<C: Verification>(
    secp: &Secp256k1<C>,
    proof: &[u8],
    commitment: PedersenCommitment,
    script: &[u8],
    generator: Generator,
) -> Result<RangeInclusive<u64>, &'static str> {
    let cbytes = commitment.serialize();
    let gbytes = generator.serialize();
    let mut c = zkp::ffi::PedersenCommitment::new();
    let mut min = 0u64;
    let mut max = 0u64;
    // SAFETY: buffers have exact serialized lengths; output objects are initialized by
    // checked parse calls before use. All pointers remain valid for each synchronous call.
    // The verification context is live, and proof/script pointers have matching lengths.
    let valid = unsafe {
        let mut g = zkp::ffi::PublicKey::new();
        if zkp::ffi::secp256k1_pedersen_commitment_parse(
            secp.ctx().as_ptr(),
            &mut c,
            cbytes.as_ptr(),
        ) != 1
            || zkp::ffi::secp256k1_generator_parse(secp.ctx().as_ptr(), &mut g, gbytes.as_ptr())
                != 1
        {
            return Err("invalid native point");
        }
        zkp::ffi::secp256k1_rangeproof_verify(
            secp.ctx().as_ptr(),
            &mut min,
            &mut max,
            &c,
            proof.as_ptr(),
            proof.len(),
            script.as_ptr(),
            script.len(),
            &g,
        )
    };
    if valid == 1 && min <= max {
        Ok(min..=max)
    } else {
        Err("invalid native range proof")
    }
}
