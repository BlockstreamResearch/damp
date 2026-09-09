use anyhow::Context;
use damp_core::registry::{DeploymentManifest, DeploymentNetwork};
use elements::AssetId;
use elements::pset::{Input, PartiallySignedTransaction};
use lwk_common::Signer as _;
use lwk_signer::SwSigner;

use crate::utxo::validated::ValidatedUtxo;

pub fn add_validated_input(pset: &mut PartiallySignedTransaction, utxo: &ValidatedUtxo) -> usize {
    let index = pset.inputs().len();
    let mut input = Input::from_prevout(utxo.outpoint);
    input.asset = Some(utxo.opening().asset);
    input.amount = Some(utxo.opening().value);
    input.witness_utxo = Some(utxo.txout.clone());
    pset.add_input(input);
    index
}

pub fn set_lwk_genesis_hash(
    pset: &mut PartiallySignedTransaction,
    deployment: &DeploymentManifest,
) -> anyhow::Result<()> {
    set_lwk_genesis_hash_for(
        pset,
        deployment.network(),
        crate::utxo::asset_id(deployment.policy_asset()),
    )
}

pub fn set_lwk_genesis_hash_for(
    pset: &mut PartiallySignedTransaction,
    deployment_network: DeploymentNetwork,
    policy_asset: AssetId,
) -> anyhow::Result<()> {
    let network = match deployment_network {
        DeploymentNetwork::LiquidTestnet => lwk_common::Network::TestnetLiquid,
        DeploymentNetwork::ElementsRegtest => {
            let params = lwk_common::ElementsParamsBuilder::new()
                .with_policy_asset(policy_asset)
                .build()?;
            lwk_common::Network::CustomElements(params)
        }
    };
    lwk_common::set_genesis_hash(pset, &network);
    Ok(())
}

pub fn finalize_lwk_wallet_inputs(
    signer: &SwSigner,
    pset: &mut PartiallySignedTransaction,
    expected_indexes: &[usize],
) -> anyhow::Result<()> {
    let signed = signer
        .sign(pset)
        .map_err(|error| anyhow::anyhow!("LWK signing failed: {error:?}"))?;
    anyhow::ensure!(
        signed == expected_indexes.len() as u32,
        "LWK signed an unexpected input set"
    );
    for index in expected_indexes {
        let input = pset
            .inputs_mut()
            .get_mut(*index)
            .context("signed wallet input index is out of range")?;
        anyhow::ensure!(
            input.partial_sigs.len() == 1,
            "wallet input needs exactly one signature"
        );
        let (public_key, signature) = input.partial_sigs.iter().next().expect("checked length");
        input.final_script_witness = Some(vec![signature.clone(), public_key.to_bytes()]);
    }
    Ok(())
}
