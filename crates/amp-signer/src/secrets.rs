//! Best-effort clearing of owned SDK secret containers. Dependency/compiler
//! copies can still exist; this is not a guarantee of complete process erasure.
use elements::TxOutSecrets;
use std::{
    collections::HashMap,
    ops::{Deref, DerefMut},
};

pub fn erase_opening(value: &mut TxOutSecrets) {
    // SAFETY: each pointer is uniquely borrowed, aligned, and points to an
    // initialized field of exactly the written type. Zero is valid for all
    // three fields. Volatile writes prevent dead-store elimination.
    unsafe {
        std::ptr::write_volatile(&mut value.value, 0);
        std::ptr::write_volatile(
            &mut value.asset_bf,
            elements::confidential::AssetBlindingFactor::zero(),
        );
        std::ptr::write_volatile(
            &mut value.value_bf,
            elements::confidential::ValueBlindingFactor::zero(),
        );
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}
#[derive(Default)]
pub struct SecretMap(HashMap<usize, TxOutSecrets>);
impl Deref for SecretMap {
    type Target = HashMap<usize, TxOutSecrets>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for SecretMap {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl From<HashMap<usize, TxOutSecrets>> for SecretMap {
    fn from(value: HashMap<usize, TxOutSecrets>) -> Self {
        Self(value)
    }
}
impl FromIterator<(usize, TxOutSecrets)> for SecretMap {
    fn from_iter<T: IntoIterator<Item = (usize, TxOutSecrets)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}
impl Drop for SecretMap {
    fn drop(&mut self) {
        for value in self.0.values_mut() {
            erase_opening(value);
        }
    }
}
