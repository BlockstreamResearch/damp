use std::collections::HashMap;
use std::str::FromStr;

use amp_core::registry::DeploymentNetwork;
use anyhow::Context;
use elements::bitcoin::PublicKey as BitcoinPublicKey;
use elements::pset::{Output, PartiallySignedTransaction};
use elements::{Address, AssetId, Script, TxOutSecrets};
use lwk_signer::SwSigner;

use crate::blinding;
use crate::keys;
use crate::model::{
    SIGNER_SDK_VERSION, SignerNetwork, SplitFundingOutput, SplitFundingRequest, SplitFundingResult,
    WalletKeyLocator,
};
use crate::transaction::{
    add_validated_input, add_wallet_metadata, decode_confidential_wallet_utxo,
    finalize_lwk_wallet_inputs, input_needs_confidential_change, parse_amount,
    set_lwk_genesis_hash_for, verify_transaction_amounts,
};

pub const MIN_SPLIT_OUTPUT_SAT: u64 = 1_001;
pub const MIN_SPLIT_FEE_SAT: u64 = 100;
pub const MAX_SPLIT_FEE_SAT: u64 = 10_000;

pub fn split_funding(
    signer: &SwSigner,
    network: SignerNetwork,
    request: SplitFundingRequest,
) -> anyhow::Result<SplitFundingResult> {
    anyhow::ensure!(
        matches!(
            (network, request.network),
            (
                SignerNetwork::LiquidTestnet,
                DeploymentNetwork::LiquidTestnet
            ) | (
                SignerNetwork::ElementsRegtest,
                DeploymentNetwork::ElementsRegtest
            )
        ),
        "signer network does not match split network"
    );
    let fee = parse_amount(&request.fee, "fee")?;
    anyhow::ensure!(
        (MIN_SPLIT_FEE_SAT..=MAX_SPLIT_FEE_SAT).contains(&fee),
        "split fee must be between 100 and 10000 sats"
    );
    let policy_asset = AssetId::from_str(&request.policy_asset)?;
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
        .wallet_key
        .as_ref()
        .context("split input needs a wallet key locator")?;
    let minimum = fee
        .checked_add(2 * MIN_SPLIT_OUTPUT_SAT)
        .context("split minimum amount overflow")?;
    anyhow::ensure!(
        source.secrets.value >= minimum,
        "split source output cannot fund two useful issuance outputs after the fee; request another faucet output instead"
    );

    // Bootstrap wallet discovery already watches these two addresses. Keeping
    // the fixed branch/index pair avoids a hidden gap while distinct vouts keep
    // the later issuance entropies independent.
    let derived = [
        keys::derive_wallet_address(signer, network, 0, 0)?,
        keys::derive_wallet_address(signer, network, 0, 1)?,
    ];
    let destinations = derived
        .iter()
        .map(|value| Address::from_str(&value.confidential_address))
        .collect::<Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        destinations
            .iter()
            .all(|address| address.blinding_pubkey.is_some()),
        "split destination address is not confidential"
    );

    let spendable = source.secrets.value - fee;
    let first = spendable / 2;
    let values = [first, spendable - first];
    let mut pset = PartiallySignedTransaction::new_v2();
    set_lwk_genesis_hash_for(&mut pset, request.network, policy_asset)?;
    add_validated_input(&mut pset, &source);
    for (address, value) in destinations.iter().zip(values) {
        pset.add_output(Output::new_explicit(
            address.script_pubkey(),
            value,
            policy_asset,
            Some(BitcoinPublicKey::new(
                address
                    .blinding_pubkey
                    .context("split destination address is not confidential")?,
            )),
        ));
    }
    pset.add_output(Output::new_explicit(Script::new(), fee, policy_asset, None));

    let secrets = HashMap::<usize, TxOutSecrets>::from([(0, source.secrets)]);
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
            == Some(source.secrets.value),
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
        source_amount: source.secrets.value.to_string(),
        fee: fee.to_string(),
        outputs: derived
            .into_iter()
            .zip(values)
            .enumerate()
            .map(|(vout, (address, amount))| SplitFundingOutput {
                vout: u32::try_from(vout).expect("two outputs fit u32"),
                amount: amount.to_string(),
                confidential_address: address.confidential_address,
                wallet_key: WalletKeyLocator {
                    branch: 0,
                    index: u32::try_from(vout).expect("two outputs fit u32"),
                },
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use amp_core::registry::{AssetMetadata, SupplyMode};
    use elements::confidential::{Asset, AssetBlindingFactor, Nonce, Value, ValueBlindingFactor};
    use elements::hashes::Hash as _;
    use elements::{TxOut, TxOutWitness, Txid};

    use crate::model::{BootstrapRequest, SpendableUtxo};

    const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn explicit_funding(
        signer: &SwSigner,
        network: SignerNetwork,
        asset: AssetId,
        value: u64,
        id: u8,
        index: u32,
    ) -> anyhow::Result<SpendableUtxo> {
        let address = keys::derive_wallet_address(signer, network, 0, index)?;
        let txout = TxOut {
            asset: Asset::Explicit(asset),
            value: Value::Explicit(value),
            nonce: Nonce::Null,
            script_pubkey: Script::from(hex::decode(address.script_pubkey)?),
            witness: TxOutWitness::default(),
        };
        Ok(SpendableUtxo {
            txid: Txid::from_byte_array([id; 32]).to_string(),
            vout: 0,
            tx_out: Some(hex::encode(elements::encode::serialize(&txout))),
            transaction: None,
            spendable: true,
            wallet_key: Some(WalletKeyLocator { branch: 0, index }),
            holder_key: None,
        })
    }

    fn confidential_funding(
        signer: &SwSigner,
        network: SignerNetwork,
        asset: AssetId,
        value: u64,
    ) -> anyhow::Result<SpendableUtxo> {
        let derived = keys::derive_wallet_address(signer, network, 0, 0)?;
        let address = Address::from_str(&derived.confidential_address)?;
        let spent = [TxOutSecrets::new(
            asset,
            AssetBlindingFactor::zero(),
            value,
            ValueBlindingFactor::zero(),
        )];
        let (txout, _, _, _) = TxOut::new_last_confidential(
            &mut rand::thread_rng(),
            elements::secp256k1_zkp::SECP256K1,
            value,
            asset,
            address.script_pubkey(),
            address.blinding_pubkey.context("confidential address")?,
            &spent,
            &[],
        )?;
        let parent = elements::Transaction {
            version: 2,
            lock_time: elements::LockTime::ZERO,
            input: Vec::new(),
            output: vec![txout],
        };
        Ok(SpendableUtxo {
            txid: parent.txid().to_string(),
            vout: 0,
            tx_out: None,
            transaction: Some(hex::encode(elements::encode::serialize(&parent))),
            spendable: true,
            wallet_key: Some(WalletKeyLocator {
                branch: 0,
                index: 0,
            }),
            holder_key: None,
        })
    }

    fn request(asset: AssetId, source_utxos: Vec<SpendableUtxo>) -> SplitFundingRequest {
        SplitFundingRequest {
            network: DeploymentNetwork::ElementsRegtest,
            policy_asset: asset.to_string(),
            source_utxos,
            fee: "500".to_owned(),
        }
    }

    #[test]
    fn split_conserves_value_and_shape() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let asset = AssetId::from_str(&"aa".repeat(32))?;
        let source = explicit_funding(&signer, network, asset, 100_000, 1, 0)?;
        let result = split_funding(&signer, network, request(asset, vec![source]))?;
        assert_eq!(result.operation, "funding-split");
        assert_eq!(result.outputs[0].amount, "49750");
        assert_eq!(result.outputs[1].amount, "49750");
        let transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(&result.transaction)?)?;
        assert_eq!(transaction.input.len(), 1);
        assert_eq!(transaction.output.len(), 3);
        assert_eq!(transaction.output[2].value.explicit(), Some(500));
        Ok(())
    }

    #[test]
    fn split_handles_odd_values_and_confidential_inputs() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let asset = AssetId::from_str(&"ab".repeat(32))?;
        let source = confidential_funding(&signer, network, asset, 100_001)?;
        let result = split_funding(&signer, network, request(asset, vec![source]))?;
        assert_eq!(result.outputs[0].amount, "49750");
        assert_eq!(result.outputs[1].amount, "49751");
        let transaction: elements::Transaction =
            elements::encode::deserialize(&hex::decode(&result.transaction)?)?;
        assert!(matches!(
            transaction.output[0].value,
            Value::Confidential(_)
        ));
        assert!(matches!(
            transaction.output[1].value,
            Value::Confidential(_)
        ));
        Ok(())
    }

    #[test]
    fn split_rejects_unnecessary_or_unusable_shapes() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let asset = AssetId::from_str(&"ac".repeat(32))?;
        let empty = split_funding(&signer, network, request(asset, vec![])).unwrap_err();
        assert_eq!(
            empty.to_string(),
            "funding split needs one confirmed L-BTC output"
        );
        let two = split_funding(
            &signer,
            network,
            request(
                asset,
                vec![
                    explicit_funding(&signer, network, asset, 10_000, 2, 0)?,
                    explicit_funding(&signer, network, asset, 10_000, 3, 1)?,
                ],
            ),
        )
        .unwrap_err();
        assert_eq!(
            two.to_string(),
            "funding already provides two distinct confirmed outputs; a split is unnecessary"
        );
        let small = split_funding(
            &signer,
            network,
            request(
                asset,
                vec![explicit_funding(&signer, network, asset, 2_501, 4, 0)?],
            ),
        )
        .unwrap_err();
        assert!(
            small
                .to_string()
                .starts_with("split source output cannot fund")
        );

        let boundary = split_funding(
            &signer,
            network,
            request(
                asset,
                vec![explicit_funding(&signer, network, asset, 2_502, 6, 0)?],
            ),
        )?;
        assert_eq!(boundary.outputs[0].amount, "1001");
        assert_eq!(boundary.outputs[1].amount, "1001");

        let mut missing_key = explicit_funding(&signer, network, asset, 10_000, 7, 0)?;
        missing_key.wallet_key = None;
        assert_eq!(
            split_funding(&signer, network, request(asset, vec![missing_key]))
                .unwrap_err()
                .to_string(),
            "split input needs a wallet key locator"
        );

        let mut low_fee = request(
            asset,
            vec![explicit_funding(&signer, network, asset, 10_000, 8, 0)?],
        );
        low_fee.fee = "50".to_owned();
        assert_eq!(
            split_funding(&signer, network, low_fee)
                .unwrap_err()
                .to_string(),
            "split fee must be between 100 and 10000 sats"
        );

        let mismatch = SplitFundingRequest {
            network: DeploymentNetwork::LiquidTestnet,
            policy_asset: asset.to_string(),
            source_utxos: vec![explicit_funding(&signer, network, asset, 10_000, 9, 0)?],
            fee: "500".to_owned(),
        };
        assert_eq!(
            split_funding(&signer, network, mismatch)
                .unwrap_err()
                .to_string(),
            "signer network does not match split network"
        );
        Ok(())
    }

    #[test]
    fn split_outputs_bootstrap_with_distinct_asset_roles() -> anyhow::Result<()> {
        let signer = SwSigner::new(MNEMONIC, false)?;
        let network = SignerNetwork::ElementsRegtest;
        let asset = AssetId::from_str(&"ad".repeat(32))?;
        let source = explicit_funding(&signer, network, asset, 100_000, 5, 0)?;
        let split = split_funding(&signer, network, request(asset, vec![source]))?;
        let funding = split
            .outputs
            .iter()
            .map(|output| SpendableUtxo {
                txid: split.txid.clone(),
                vout: output.vout,
                tx_out: None,
                transaction: Some(split.transaction.clone()),
                spendable: true,
                wallet_key: Some(output.wallet_key.clone()),
                holder_key: None,
            })
            .collect();
        let bootstrapped = crate::bootstrap::bootstrap(
            &signer,
            network,
            BootstrapRequest {
                network: DeploymentNetwork::ElementsRegtest,
                policy_asset: asset.to_string(),
                deployment_salt: "45".repeat(32),
                asset: AssetMetadata {
                    name: "Split lifecycle".to_owned(),
                    ticker: "SPL".to_owned(),
                    precision: 0,
                },
                issued_supply: "1000".to_owned(),
                supply_mode: SupplyMode::Fixed,
                policy_utxos: funding,
                fee: "2000".to_owned(),
                required_confirmations: 1,
            },
        )?;
        assert_ne!(
            bootstrapped.deployment.regulated_asset,
            bootstrapped.deployment.verifier_asset
        );
        Ok(())
    }
}
