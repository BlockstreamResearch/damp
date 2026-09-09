use anyhow::Context;
use elements::confidential::{Asset, AssetBlindingFactor, Nonce, Value, ValueBlindingFactor};
use elements::hashes::Hash as _;
use elements::{AssetId, Script, TxOut, TxOutSecrets, TxOutWitness};
use simplicity_damp_signer::{
    Signer,
    keys::{HolderKeyLocator, WalletBranch, WalletKeyLocator},
    network::DeploymentNetwork,
    utxo::{InputSource, InputStatus, Ownership, Utxo},
};

pub const MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

pub fn public_asset(value: AssetId) -> damp_core::ledger::AssetId {
    let mut bytes = value.into_inner().to_byte_array();
    bytes.reverse();
    bytes.into()
}

pub fn funding_utxo(
    signer: &Signer,
    _network: DeploymentNetwork,
    asset: AssetId,
    value: u64,
    txid_byte: u8,
    index: u32,
) -> anyhow::Result<Utxo> {
    let address = signer.wallet_address(WalletBranch::Receive, index.try_into()?)?;
    let txout = TxOut {
        asset: Asset::Explicit(asset),
        value: Value::Explicit(value),
        nonce: Nonce::Null,
        script_pubkey: Script::from(hex::decode(address.script_pubkey)?),
        witness: TxOutWitness::default(),
    };
    Ok(Utxo::new(
        damp_core::ledger::Outpoint::new(
            damp_core::ledger::ConsensusTxid::from([txid_byte; 32]).into(),
            0,
        ),
        InputSource::Output(txout),
        Ownership::Wallet(WalletKeyLocator {
            branch: WalletBranch::Receive,
            index: index.try_into()?,
        }),
        InputStatus::Spendable,
    )?)
}

pub fn confidential_funding_utxo(
    signer: &Signer,
    _network: DeploymentNetwork,
    asset: AssetId,
    value: u64,
    index: u32,
) -> anyhow::Result<Utxo> {
    let derived = signer.wallet_address(WalletBranch::Receive, index.try_into()?)?;
    let address = derived.confidential_address.as_address();
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
    Ok(Utxo::new(
        damp_core::ledger::Outpoint::new(
            damp_core::ledger::ConsensusTxid::from(parent.txid().to_byte_array()).into(),
            0,
        ),
        InputSource::Parent(parent),
        Ownership::Wallet(WalletKeyLocator {
            branch: WalletBranch::Receive,
            index: index.try_into()?,
        }),
        InputStatus::Spendable,
    )?)
}

pub fn parent_utxo(
    txid: &str,
    vout: u32,
    transaction: &str,
    wallet_key: Option<WalletKeyLocator>,
    holder_key: Option<HolderKeyLocator>,
) -> Utxo {
    let ownership = match (wallet_key, holder_key) {
        (Some(key), None) => Ownership::Wallet(key),
        (None, Some(key)) => Ownership::Holder(key),
        (None, None) => Ownership::Unlocated,
        _ => panic!("fixture has conflicting locators"),
    };
    Utxo::new(
        damp_core::ledger::Outpoint::new(txid.parse().unwrap(), vout),
        InputSource::Parent(
            elements::encode::deserialize(&hex::decode(transaction).unwrap()).unwrap(),
        ),
        ownership,
        InputStatus::Spendable,
    )
    .unwrap()
}
