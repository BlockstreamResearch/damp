use rand::{CryptoRng, RngCore};
use secp256k1_zkp::{Scalar, SecretKey};
use zeroize::Zeroizing;

use super::{AuditError, ProofEncodingError};

pub(super) const ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

// Drop clears the currently owned libsecp value, not compiler or dependency copies.
pub(super) struct ErasedSecret(pub(super) SecretKey);
pub(super) struct ErasedScalar(pub(super) Scalar);
impl Drop for ErasedSecret {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}
impl Drop for ErasedScalar {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}
impl ErasedSecret {
    pub(super) fn random<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        loop {
            let mut bytes = Zeroizing::new([0; 32]);
            rng.fill_bytes(bytes.as_mut());
            if let Ok(secret) = SecretKey::from_slice(bytes.as_ref()) {
                return Self(secret);
            }
        }
    }
}

pub(super) fn reduce(mut bytes: [u8; 32]) -> Result<Scalar, ProofEncodingError> {
    if bytes >= ORDER {
        let mut borrow = 0i16;
        for index in (0..32).rev() {
            let value = i16::from(bytes[index]) - i16::from(ORDER[index]) - borrow;
            bytes[index] = value as u8;
            borrow = i16::from(value < 0);
        }
    }
    Scalar::from_be_bytes(bytes).map_err(|_| ProofEncodingError::Scalar)
}

pub(super) fn response(
    nonce: &SecretKey,
    challenge: Scalar,
    opening: &SecretKey,
) -> Result<Scalar, AuditError> {
    if challenge == Scalar::ZERO {
        return Ok(Scalar::from(*nonce));
    }
    let product = ErasedSecret(opening.mul_tweak(&challenge)?);
    let nonce_scalar = ErasedScalar(Scalar::from(*nonce));
    match product.0.add_tweak(&nonce_scalar.0) {
        Ok(sum) => {
            let sum = ErasedSecret(sum);
            Ok(Scalar::from(sum.0))
        }
        Err(secp256k1_zkp::UpstreamError::InvalidTweak) => Ok(Scalar::ZERO),
        Err(error) => Err(error.into()),
    }
}

// A fixed public exponent keeps inversion inside libsecp secret-key arithmetic.
pub(super) fn inverse(secret: &SecretKey) -> Result<ErasedScalar, AuditError> {
    let mut exponent = ORDER;
    exponent[31] -= 2;
    let mut power = ErasedSecret(*secret);
    let base = ErasedScalar(Scalar::from(*secret));
    for bit in 1..256 {
        let square = ErasedScalar(Scalar::from(power.0));
        power = ErasedSecret(power.0.mul_tweak(&square.0)?);
        if exponent[bit / 8] & (1 << (7 - bit % 8)) != 0 {
            power = ErasedSecret(power.0.mul_tweak(&base.0)?);
        }
    }
    Ok(ErasedScalar(Scalar::from(power.0)))
}
