use anyhow::Context;
use elements::Script;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::pset::{Output, PartiallySignedTransaction};
use lwk_signer::SwSigner;

use crate::SIGNER_SDK_VERSION;
use crate::blinding;
use crate::keys;
use crate::keys::WalletKeyLocator;
use crate::network::DeploymentNetwork;
use crate::ops::request::SplitFundingRequest;
use crate::ops::review::SplitFundingOutput;
use crate::ops::review::SplitFundingResult;
use crate::transaction::{
    add_validated_input, add_wallet_metadata, decode_confidential_wallet_utxo,
    finalize_lwk_wallet_inputs, input_needs_confidential_change, set_lwk_genesis_hash_for,
    verify_transaction_amounts,
};

pub const MIN_SPLIT_OUTPUT_SAT: u64 = 1_001;
pub const MIN_SPLIT_FEE_SAT: u64 = 100;
pub const MAX_SPLIT_FEE_SAT: u64 = 10_000;

pub fn split_funding(
    signer: &SwSigner,
    network: DeploymentNetwork,
    request: SplitFundingRequest,
) -> anyhow::Result<SplitFundingResult> {
    crate::network::require_network(network, request.network)?;
    let fee = request.fee.get();
    anyhow::ensure!(
        (MIN_SPLIT_FEE_SAT..=MAX_SPLIT_FEE_SAT).contains(&fee),
        "split fee must be between 100 and 10000 sats"
    );
    let policy_asset = crate::utxo::asset_id(request.policy_asset);
    let mut candidates = request
        .source_utxos
        .iter()
        .map(|utxo| decode_confidential_wallet_utxo(signer, utxo, policy_asset))
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        !candidates.is_empty(),
        "funding split needs one confirmed L-BTC output"
    );
    anyhow::ensure!(
        candidates.len() == 1,
        "funding already provides two distinct confirmed outputs; a split is unnecessary"
    );
    let source = candidates.pop().expect("validated one candidate");
    let source_locator = source
        .wallet_key()
        .context("split input needs a wallet key locator")?;
    let minimum = fee
        .checked_add(2 * MIN_SPLIT_OUTPUT_SAT)
        .context("split minimum amount overflow")?;
    anyhow::ensure!(
        source.opening().value >= minimum,
        "split source output cannot fund two useful issuance outputs after the fee; request another faucet output instead"
    );

    // Bootstrap wallet discovery already watches these two addresses. Keeping
    // the fixed branch/index pair avoids a hidden gap while distinct vouts keep
    // the later issuance entropies independent.
    let derived = [
        keys::derive_wallet_address(
            signer,
            network,
            crate::keys::WalletBranch::Receive,
            0.try_into()?,
        )?,
        keys::derive_wallet_address(
            signer,
            network,
            crate::keys::WalletBranch::Receive,
            1.try_into()?,
        )?,
    ];
    let destinations = derived
        .iter()
        .map(|value| &value.confidential_address)
        .collect::<Vec<_>>();

    let spendable = source.opening().value - fee;
    let first = spendable / 2;
    let values = [first, spendable - first];
    let mut pset = PartiallySignedTransaction::new_v2();
    set_lwk_genesis_hash_for(&mut pset, request.network, policy_asset)?;
    add_validated_input(&mut pset, &source);
    for (address, value) in destinations.iter().zip(values) {
        pset.add_output(Output::new_explicit(
            address.as_address().script_pubkey(),
            value,
            policy_asset,
            Some(BitcoinPublicKey::new(address.blinding_key())),
        ));
    }
    pset.add_output(Output::new_explicit(Script::new(), fee, policy_asset, None));

    let secrets = [(0, source.opening())]
        .into_iter()
        .collect::<crate::blinding::secrets::InputOpenings>();
    if input_needs_confidential_change(&source) {
        blinding::blind_values(&mut pset, &secrets, &[0, 1])
            .context("split value blinding failed")?;
    }
    add_wallet_metadata(
        signer,
        &mut pset,
        0,
        source_locator,
        &source.txout.script_pubkey,
    )?;
    finalize_lwk_wallet_inputs(signer, &mut pset, &[0])?;
    let transaction = pset.extract_tx()?;
    verify_transaction_amounts(&transaction, std::slice::from_ref(&source.txout))
        .context("split transaction proof validation failed")?;
    anyhow::ensure!(
        values[0]
            .checked_add(values[1])
            .and_then(|total| total.checked_add(fee))
            == Some(source.opening().value),
        "split outputs and fee do not conserve the source value"
    );

    let transaction_hex = hex::encode(elements::encode::serialize(&transaction));
    let txid = transaction.txid().to_string();
    Ok(SplitFundingResult {
        sdk: SIGNER_SDK_VERSION,
        operation: "funding-split",
        pset: pset.to_string(),
        transaction: transaction_hex,
        txid,
        source_txid: source.outpoint.txid.to_string(),
        source_vout: source.outpoint.vout,
        source_amount: source.opening().value.to_string(),
        fee: request.fee,
        outputs: derived
            .into_iter()
            .zip(values)
            .enumerate()
            .map(|(vout, (address, amount))| SplitFundingOutput {
                vout: u32::try_from(vout).expect("two outputs fit u32"),
                amount: amount.to_string(),
                confidential_address: address.confidential_address,
                wallet_key: WalletKeyLocator {
                    branch: crate::keys::WalletBranch::Receive,
                    index: crate::keys::KeyIndex::try_from(
                        u32::try_from(vout).expect("two outputs fit u32"),
                    )
                    .expect("two normal child indices"),
                },
            })
            .collect(),
    })
}
