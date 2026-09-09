use anyhow::Context;
use elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};

use super::validated::ValidatedUtxo;

pub fn select_smallest_sufficient(
    mut values: Vec<ValidatedUtxo>,
    target: u64,
    max_inputs: usize,
) -> anyhow::Result<Vec<ValidatedUtxo>> {
    values.sort_by(|left, right| {
        left.opening()
            .value
            .cmp(&right.opening().value)
            .then_with(|| left.outpoint.txid.cmp(&right.outpoint.txid))
            .then_with(|| left.outpoint.vout.cmp(&right.outpoint.vout))
    });
    if let Some(index) = values
        .iter()
        .position(|utxo| utxo.opening().value >= target)
    {
        return Ok(vec![values.swap_remove(index)]);
    }
    let mut selected = Vec::new();
    let mut total = 0u64;
    for utxo in values.into_iter().rev().take(max_inputs) {
        total = total
            .checked_add(utxo.opening().value)
            .context("input amount overflow")?;
        selected.push(utxo);
        if total >= target {
            return Ok(selected);
        }
    }
    anyhow::bail!("insufficient balance")
}

/// Select fee inputs while preserving enough value to reblind change whenever any selected input
/// carries a confidential asset or value commitment. Exact-value explicit inputs remain usable;
/// exact-value confidential inputs are skipped in favor of a larger candidate.
pub fn select_fee_funding(
    mut values: Vec<ValidatedUtxo>,
    target: u64,
    max_inputs: usize,
    confidential_change: u64,
) -> anyhow::Result<Vec<ValidatedUtxo>> {
    anyhow::ensure!(max_inputs > 0, "fee selection allows no inputs");
    let confidential_target = target
        .checked_add(confidential_change)
        .context("fee target overflow")?;
    values.sort_by(|left, right| {
        left.opening()
            .value
            .cmp(&right.opening().value)
            .then_with(|| left.outpoint.txid.cmp(&right.outpoint.txid))
            .then_with(|| left.outpoint.vout.cmp(&right.outpoint.vout))
    });

    if let Some(index) = values.iter().position(|utxo| {
        utxo.opening().value
            >= if input_needs_confidential_change(utxo) {
                confidential_target
            } else {
                target
            }
    }) {
        return Ok(vec![values.swap_remove(index)]);
    }

    // Prefer an explicit-only combination when it can pay the exact fee. This
    // avoids imposing confidential-change headroom unnecessarily.
    let mut explicit_total = 0u64;
    let mut explicit_count = 0usize;
    for utxo in values
        .iter()
        .rev()
        .filter(|utxo| !input_needs_confidential_change(utxo))
        .take(max_inputs)
    {
        explicit_total = explicit_total
            .checked_add(utxo.opening().value)
            .context("input amount overflow")?;
        explicit_count += 1;
        if explicit_total >= target {
            return Ok(values
                .into_iter()
                .rev()
                .filter(|utxo| !input_needs_confidential_change(utxo))
                .take(explicit_count)
                .collect());
        }
    }

    let mut selected = Vec::new();
    let mut total = 0u64;
    let mut needs_change = false;
    for utxo in values.into_iter().rev().take(max_inputs) {
        total = total
            .checked_add(utxo.opening().value)
            .context("input amount overflow")?;
        needs_change |= input_needs_confidential_change(&utxo);
        selected.push(utxo);
        let required = if needs_change {
            confidential_target
        } else {
            target
        };
        if total >= required {
            return Ok(selected);
        }
    }
    anyhow::bail!("insufficient balance with confidential-change headroom")
}

pub(crate) fn input_needs_confidential_change(utxo: &ValidatedUtxo) -> bool {
    utxo.opening().asset_bf != AssetBlindingFactor::zero()
        || utxo.opening().value_bf != ValueBlindingFactor::zero()
}

#[cfg(test)]
mod fee_selection_tests {
    use super::*;
    use elements::TxOutWitness;
    use elements::confidential::Nonce;
    use elements::confidential::{Asset, Value};
    use elements::{AssetId, OutPoint, Script, TxOut, TxOutSecrets, Txid};
    use std::str::FromStr;

    fn candidate(value: u64, id: u8, confidential: bool) -> ValidatedUtxo {
        let asset = AssetId::from_str(&"11".repeat(32)).expect("asset");
        let value_bf = if confidential {
            ValueBlindingFactor::new(&mut rand::thread_rng())
        } else {
            ValueBlindingFactor::zero()
        };
        ValidatedUtxo {
            outpoint: OutPoint::new(Txid::from_str(&format!("{id:064x}")).expect("txid"), 0),
            txout: TxOut {
                asset: Asset::Explicit(asset),
                value: Value::Explicit(value),
                nonce: Nonce::Null,
                script_pubkey: Script::new(),
                witness: TxOutWitness::default(),
            },
            opening: TxOutSecrets::new(asset, AssetBlindingFactor::zero(), value, value_bf),
            ownership: crate::utxo::Ownership::Unlocated,
        }
    }

    #[test]
    fn confidential_exact_fee_uses_larger_candidate_with_change() {
        let selected = select_fee_funding(
            vec![candidate(2_000, 1, true), candidate(5_000, 2, true)],
            2_000,
            1,
            1,
        )
        .expect("larger confidential candidate");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].opening().value, 5_000);
    }

    #[test]
    fn exact_explicit_inputs_need_no_change_headroom() {
        let selected = select_fee_funding(
            vec![candidate(1_000, 1, false), candidate(1_000, 2, false)],
            2_000,
            2,
            1,
        )
        .expect("explicit exact-fee combination");
        assert_eq!(selected.len(), 2);
        assert_eq!(
            selected
                .iter()
                .map(|utxo| utxo.opening().value)
                .sum::<u64>(),
            2_000
        );
    }
}
