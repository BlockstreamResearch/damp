use std::borrow::Cow;

use rand::{CryptoRng, RngCore};
use secp256k1_zkp::{PublicKey, Scalar, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::{
    AuditError, AuditOpening, AuditStatement, ProofEncodingError,
    point::{FieldElement, add, scale},
    scalar::{ErasedScalar, ErasedSecret, reduce, response},
    statement::tagged_hash,
};

/// Canonically parsed proof fields. Verification binds them to an output and transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAuditProof {
    commitment_parity: bool,
    commitment_root: FieldElement,
    handle: PublicKey,
    commitment_nonce: PublicKey,
    handle_nonce: PublicKey,
    value_response: Scalar,
    blinder_response: Scalar,
}

/// A proof whose equations hold for the retained immutable statement.
#[derive(Debug, Clone)]
pub struct VerifiedAuditProof<'a> {
    proof: Cow<'a, NativeAuditProof>,
    statement: &'a AuditStatement,
}
impl VerifiedAuditProof<'_> {
    pub fn proof(&self) -> &NativeAuditProof {
        &self.proof
    }
    pub const fn statement(&self) -> &AuditStatement {
        self.statement
    }
    pub fn into_proof(self) -> NativeAuditProof {
        self.proof.into_owned()
    }
}

impl NativeAuditProof {
    pub const ENCODED_LEN: usize = 196;

    /// Parse witness fields without asserting their equations.
    ///
    /// # Errors
    /// Rejects responses outside the scalar field and a noncanonical root.
    pub fn from_parts(
        commitment_parity: bool,
        commitment_root: [u8; 32],
        handle: PublicKey,
        commitment_nonce: PublicKey,
        handle_nonce: PublicKey,
        value_response: [u8; 32],
        blinder_response: [u8; 32],
    ) -> Result<Self, ProofEncodingError> {
        let value_response =
            Scalar::from_be_bytes(value_response).map_err(|_| ProofEncodingError::Scalar)?;
        let blinder_response =
            Scalar::from_be_bytes(blinder_response).map_err(|_| ProofEncodingError::Scalar)?;
        Ok(Self {
            commitment_parity,
            commitment_root: FieldElement::parse(commitment_root)?,
            handle,
            commitment_nonce,
            handle_nonce,
            value_response,
            blinder_response,
        })
    }

    pub const fn commitment_parity(&self) -> bool {
        self.commitment_parity
    }
    pub const fn commitment_root(&self) -> [u8; 32] {
        self.commitment_root.bytes()
    }
    pub const fn handle(&self) -> PublicKey {
        self.handle
    }
    pub const fn commitment_nonce(&self) -> PublicKey {
        self.commitment_nonce
    }
    pub const fn handle_nonce(&self) -> PublicKey {
        self.handle_nonce
    }
    pub fn value_response(&self) -> [u8; 32] {
        self.value_response.to_be_bytes()
    }
    pub fn blinder_response(&self) -> [u8; 32] {
        self.blinder_response.to_be_bytes()
    }

    pub fn encode(&self) -> [u8; Self::ENCODED_LEN] {
        let mut out = [0; Self::ENCODED_LEN];
        out[0] = u8::from(self.commitment_parity);
        out[1..33].copy_from_slice(&self.commitment_root());
        out[33..66].copy_from_slice(&self.handle.serialize());
        out[66..99].copy_from_slice(&self.commitment_nonce.serialize());
        out[99..132].copy_from_slice(&self.handle_nonce.serialize());
        out[132..164].copy_from_slice(&self.value_response());
        out[164..].copy_from_slice(&self.blinder_response());
        out
    }

    /// Parse the fixed 196-byte proof encoding.
    ///
    /// # Errors
    /// Rejects wrong lengths, invalid points and noncanonical field/scalar values.
    pub fn decode(bytes: &[u8]) -> Result<Self, ProofEncodingError> {
        let bytes: &[u8; Self::ENCODED_LEN] =
            bytes.try_into().map_err(|_| ProofEncodingError::Length)?;
        if bytes[0] > 1 {
            return Err(ProofEncodingError::Parity);
        }
        Self::from_parts(
            bytes[0] == 1,
            bytes[1..33]
                .try_into()
                .map_err(|_| ProofEncodingError::Length)?,
            PublicKey::from_slice(&bytes[33..66]).map_err(|_| ProofEncodingError::Point)?,
            PublicKey::from_slice(&bytes[66..99]).map_err(|_| ProofEncodingError::Point)?,
            PublicKey::from_slice(&bytes[99..132]).map_err(|_| ProofEncodingError::Point)?,
            bytes[132..164]
                .try_into()
                .map_err(|_| ProofEncodingError::Length)?,
            bytes[164..]
                .try_into()
                .map_err(|_| ProofEncodingError::Length)?,
        )
    }

    /// Produce and self-verify a proof after the transaction digest is fixed.
    ///
    /// # Errors
    /// Rejects an opening for a different commitment or a failed curve equation.
    pub fn prove<'a, R: RngCore + CryptoRng>(
        rng: &mut R,
        statement: &'a AuditStatement,
        opening: &AuditOpening,
    ) -> Result<VerifiedAuditProof<'a>, AuditError> {
        let output = statement.output();
        if opening.commitment(output.asset())? != output.commitment() {
            return Err(AuditError::CommitmentMismatch);
        }
        let secp = Secp256k1::new();
        loop {
            let a = ErasedSecret::random(rng);
            let b = ErasedSecret::random(rng);
            let a_scalar = ErasedScalar(Scalar::from(a.0));
            let b_scalar = ErasedScalar(Scalar::from(b.0));
            let tc = add(
                scale(output.generator(), a_scalar.0)?,
                Some(PublicKey::from_secret_key(&secp, &b.0)),
            )?;
            let Some(tc) = tc else {
                continue;
            };
            let mut proof = Self {
                commitment_parity: output.point().key.serialize()[0] == 3,
                commitment_root: output.point().root,
                handle: opening.handle(statement.domain().key())?,
                commitment_nonce: tc,
                handle_nonce: statement
                    .domain()
                    .key()
                    .public_key()
                    .mul_tweak(&secp, &b_scalar.0)?,
                value_response: Scalar::ZERO,
                blinder_response: Scalar::ZERO,
            };
            let e = challenge(statement, &proof)?;
            let mut value_bytes = Zeroizing::new([0; 32]);
            value_bytes[24..].copy_from_slice(&opening.value().get().to_be_bytes());
            let value = ErasedSecret(SecretKey::from_slice(value_bytes.as_ref())?);
            proof.value_response = response(&a.0, e, &value.0)?;
            proof.blinder_response = response(&b.0, e, opening.blinder())?;
            proof.verify_equations(statement)?;
            return Ok(VerifiedAuditProof {
                proof: Cow::Owned(proof),
                statement,
            });
        }
    }

    /// Verify both equations and the native commitment's QR sign.
    ///
    /// # Errors
    /// Rejects a mismatched native root/parity or either failed Sigma equation.
    /// This does not establish chain inclusion or authenticate recovery bytes.
    pub fn verify<'a>(
        &'a self,
        statement: &'a AuditStatement,
    ) -> Result<VerifiedAuditProof<'a>, AuditError> {
        self.verify_equations(statement)?;
        Ok(VerifiedAuditProof {
            proof: Cow::Borrowed(self),
            statement,
        })
    }

    fn verify_equations(&self, statement: &AuditStatement) -> Result<(), AuditError> {
        let output = statement.output();
        let native = output.point();
        if self.commitment_parity != (native.key.serialize()[0] == 3) {
            return Err(AuditError::Parity);
        }
        if !self.commitment_root.squares_to(native.root_square) {
            return Err(AuditError::Root);
        }
        let e = challenge(statement, self)?;
        let mut one = [0; 32];
        one[31] = 1;
        let g = PublicKey::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&one)?);
        if add(
            scale(output.generator(), self.value_response)?,
            scale(g, self.blinder_response)?,
        )? != add(scale(native.key, e)?, Some(self.commitment_nonce))?
        {
            return Err(AuditError::CommitmentEquation);
        }
        if scale(statement.domain().key().public_key(), self.blinder_response)?
            != add(scale(self.handle, e)?, Some(self.handle_nonce))?
        {
            return Err(AuditError::HandleEquation);
        }
        Ok(())
    }
}

fn challenge(statement: &AuditStatement, proof: &NativeAuditProof) -> Result<Scalar, AuditError> {
    let domain = statement.domain();
    let output = statement.output();
    let mut bytes = Vec::new();
    bytes.extend(domain.deployment().to_byte_array());
    bytes.extend(2u32.to_be_bytes());
    bytes.extend(domain.epoch().get().to_be_bytes());
    bytes.extend(domain.key().to_byte_array());
    bytes.extend(statement.sig_all_hash().to_byte_array());
    bytes.extend(output.index().to_be_bytes());
    bytes.extend(output.consensus_asset());
    bytes.extend(output.commitment().serialize());
    bytes.extend(output.script_hash().to_byte_array());
    bytes.push(0);
    bytes.extend(Sha256::digest(statement.auxiliary().as_ref()));
    bytes.extend(proof.handle.serialize());
    bytes.extend(proof.commitment_nonce.serialize());
    bytes.extend(proof.handle_nonce.serialize());
    Ok(reduce(tagged_hash(b"DAMP/audit/autonomous/v3", &bytes))?)
}
