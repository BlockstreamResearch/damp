use damp_core::native_audit::{
    AUXILIARY_BYTES, AuditError, AuxiliaryRecord, NativeAuditProof, ProofEncodingError,
};
use elements::secp256k1_zkp::PublicKey;
use simplicityhl::simplicity::{
    RedeemNode,
    dag::{DagLike, InternalSharing},
    node::Inner,
};

use super::RecoveryError;

const RECORD_BITS: usize = 42868;
const MAX_RECORDS: usize = damp_core::protocol_limits::MAX_REGULATED_OUTPUTS;
pub(super) const RANGE_BODY_BYTES: usize = 5060;
pub(super) const RANGE_HEADER: [u8; 10] = [0x60, 0x3e, 0, 0, 0, 0, 0, 0, 0, 1];

pub(super) struct Record {
    pub index: u32,
    pub proof: NativeAuditProof,
    pub auxiliary: AuxiliaryRecord,
    pub range_body: [u8; RANGE_BODY_BYTES],
}
struct Bits {
    bits: Vec<bool>,
    offset: usize,
}
impl Bits {
    fn bit(&mut self) -> Result<bool, RecoveryError> {
        let bit = *self
            .bits
            .get(self.offset)
            .ok_or(RecoveryError::TruncatedWitness)?;
        self.offset += 1;
        Ok(bit)
    }
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], RecoveryError> {
        let end = self
            .offset
            .checked_add(N * 8)
            .ok_or(RecoveryError::TruncatedWitness)?;
        if end > self.bits.len() {
            return Err(RecoveryError::TruncatedWitness);
        }
        let mut bytes = [0; N];
        for bit in 0..N * 8 {
            bytes[bit / 8] |= u8::from(self.bits[self.offset + bit]) << (7 - bit % 8);
        }
        self.offset = end;
        Ok(bytes)
    }
    fn point(&mut self) -> Result<PublicKey, RecoveryError> {
        let mut bytes = [0; 33];
        bytes[0] = 2 + u8::from(self.bit()?);
        bytes[1..].copy_from_slice(&self.bytes::<32>()?);
        PublicKey::from_slice(&bytes)
            .map_err(|_| AuditError::Encoding(ProofEncodingError::Point).into())
    }
}

pub(super) fn records(program: &RedeemNode) -> Result<Vec<Record>, RecoveryError> {
    let mut candidates = program
        .post_order_iter::<InternalSharing>()
        .filter_map(|item| match item.node.inner() {
            Inner::Witness(value) => {
                let bits = value.iter_compact().collect::<Vec<_>>();
                (bits.len() >= MAX_RECORDS + RECORD_BITS
                    && bits.len() <= MAX_RECORDS + MAX_RECORDS * RECORD_BITS
                    && (bits.len() - MAX_RECORDS).is_multiple_of(RECORD_BITS))
                .then_some(bits)
            }
            _ => None,
        });
    let bits = candidates.next().ok_or(RecoveryError::WitnessCount)?;
    if candidates.next().is_some() {
        return Err(RecoveryError::WitnessCount);
    }
    let mut reader = Bits { bits, offset: 0 };
    let mut records = Vec::new();
    for _ in 0..MAX_RECORDS {
        if !reader.bit()? {
            continue;
        }
        let index = u32::from_be_bytes(reader.bytes()?);
        let proof = NativeAuditProof::from_parts(
            reader.bit()?,
            reader.bytes()?,
            reader.point()?,
            reader.point()?,
            reader.point()?,
            reader.bytes()?,
            reader.bytes()?,
        )
        .map_err(AuditError::from)?;
        records.push(Record {
            index,
            proof,
            auxiliary: AuxiliaryRecord::from_byte_array(reader.bytes::<AUXILIARY_BYTES>()?),
            range_body: reader.bytes()?,
        });
    }
    if reader.offset != reader.bits.len() {
        return Err(RecoveryError::TrailingWitness);
    }
    Ok(records)
}
