//! Public-fixture admission validation, not an authenticated service or custody implementation.
use simplex::simplicityhl::elements::{
    self, AssetId, Transaction, confidential,
    secp256k1_zkp::{Generator, PedersenCommitment, PublicKey, Scalar, Secp256k1, Tweak},
};
#[derive(Clone)]
pub struct Opening {
    pub index: u32,
    pub value: u64,
    pub blinder: [u8; 32],
    pub handle: [u8; 33],
}
pub fn validate(
    tx: &Transaction,
    asset: AssetId,
    audit_key: PublicKey,
    openings: &[Opening],
) -> Result<(), &'static str> {
    if tx.input.iter().any(elements::TxIn::has_issuance) {
        return Err("issuance unsupported in ordinary admission");
    }
    if tx.output.iter().any(|o| o.asset.explicit().is_none()) {
        return Err("all output assets must be explicit");
    }
    let expected: Vec<_> = tx
        .output
        .iter()
        .enumerate()
        .filter(|(_, o)| o.asset.explicit() == Some(asset))
        .collect();
    if expected.is_empty() || expected.len() > 10 || expected.len() != openings.len() {
        return Err("audit record count");
    }
    let secp = Secp256k1::new();
    let generator = Generator::new_unblinded(&secp, asset.into_tag());
    for ((index, out), opening) in expected.into_iter().zip(openings) {
        if opening.index as usize != index {
            return Err("audit record order/index");
        }
        let scalar = Scalar::from_be_bytes(opening.blinder).map_err(|_| "noncanonical blinder")?;
        if scalar == Scalar::ZERO {
            return Err("identity audit handle unsupported");
        }
        let blind = Tweak::from_slice(&opening.blinder).map_err(|_| "invalid blinder")?;
        if out.value
            != confidential::Value::Confidential(PedersenCommitment::new(
                &secp,
                opening.value,
                blind,
                generator,
            ))
        {
            return Err("native commitment mismatch");
        }
        let handle = PublicKey::from_slice(&opening.handle).map_err(|_| "invalid audit handle")?;
        if audit_key
            .mul_tweak(&secp, &scalar)
            .map_err(|_| "identity audit handle")?
            != handle
        {
            return Err("audit handle mismatch");
        }
    }
    Ok(())
}
