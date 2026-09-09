use anyhow::Context;
use elements::Transaction;

/// Validate the reviewed fee against the exact finalized Liquid transaction shape.
///
/// LWK's transaction builder cannot construct the custom Simplicity inputs used here, so the
/// signer builds those inputs itself. Once every witness and proof is present, however, LWK's
/// fee utility can price the exact ELIP-200 discounted weight without relying on browser-side
/// byte-count guesses.
pub fn validate_network_fee(transaction: &Transaction, reviewed_fee: u64) -> anyhow::Result<()> {
    let paid_fee = transaction
        .output
        .iter()
        .filter(|output| output.is_fee())
        .try_fold(0u64, |sum, output| {
            let value = output
                .value
                .explicit()
                .context("fee output value must be explicit")?;
            sum.checked_add(value).context("transaction fee overflow")
        })?;
    anyhow::ensure!(
        paid_fee == reviewed_fee,
        "final transaction fee differs from the reviewed fee"
    );

    let minimum =
        lwk_common::calculate_fee(transaction.discount_weight(), lwk_common::DEFAULT_FEE_RATE);
    anyhow::ensure!(
        paid_fee >= minimum,
        "reviewed fee is below LWK's finalized transaction minimum of {minimum} sats"
    );
    Ok(())
}
