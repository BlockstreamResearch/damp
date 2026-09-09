//! Best-effort clearing of owned SDK secret containers. Dependency/compiler
//! copies can still exist; this is not a guarantee of complete process erasure.
use elements::TxOutSecrets;
use std::collections::HashMap;

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
/// Borrow input openings without duplicating their secret values.
pub struct InputOpenings<'a>(HashMap<usize, &'a TxOutSecrets>);
impl<'a> InputOpenings<'a> {
    pub fn get(&self, index: &usize) -> Option<&'a TxOutSecrets> {
        self.0.get(index).copied()
    }
    pub fn values(&self) -> impl Iterator<Item = &'a TxOutSecrets> {
        self.0.values().copied()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
}
impl<'a> FromIterator<(usize, &'a TxOutSecrets)> for InputOpenings<'a> {
    fn from_iter<T: IntoIterator<Item = (usize, &'a TxOutSecrets)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}
impl std::fmt::Debug for InputOpenings<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InputOpenings")
            .field("len", &self.len())
            .finish_non_exhaustive()
    }
}

/// Own newly generated output openings and clear them on replacement or drop.
#[derive(Default)]
pub struct OutputOpenings(HashMap<usize, TxOutSecrets>);
impl OutputOpenings {
    pub fn get(&self, index: &usize) -> Option<&TxOutSecrets> {
        self.0.get(index)
    }
    pub fn insert(&mut self, index: usize, value: TxOutSecrets) {
        if let Some(mut previous) = self.0.insert(index, value) {
            erase_opening(&mut previous);
        }
    }
}
impl std::fmt::Debug for OutputOpenings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputOpenings")
            .field("len", &self.0.len())
            .finish_non_exhaustive()
    }
}
impl Drop for OutputOpenings {
    fn drop(&mut self) {
        for value in self.0.values_mut() {
            erase_opening(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};

    #[test]
    fn input_maps_borrow_and_debug_omits_openings() {
        let opening = TxOutSecrets::new(
            elements::AssetId::LIQUID_BTC,
            AssetBlindingFactor::zero(),
            891234567,
            ValueBlindingFactor::zero(),
        );
        let inputs = [(0, &opening)].into_iter().collect::<InputOpenings>();
        assert!(std::ptr::eq(inputs.get(&0).unwrap(), &opening));
        assert!(!format!("{inputs:?}").contains("891234567"));
        let mut outputs = OutputOpenings::default();
        outputs.insert(0, opening);
        assert!(!format!("{outputs:?}").contains("891234567"));
    }

    #[test]
    fn erasing_an_owned_opening_clears_value_and_blinders() {
        let mut rng = rand::thread_rng();
        let mut opening = TxOutSecrets::new(
            elements::AssetId::LIQUID_BTC,
            AssetBlindingFactor::new(&mut rng),
            891234567,
            ValueBlindingFactor::new(&mut rng),
        );
        erase_opening(&mut opening);
        assert_eq!(opening.value, 0);
        assert_eq!(opening.asset_bf, AssetBlindingFactor::zero());
        assert_eq!(opening.value_bf, ValueBlindingFactor::zero());
    }
}
