import type { Deployment, PolicySnapshot } from "./domain";
import type { WalletSyncSnapshot, WalletSyncUtxo } from "./wallet-sync";

export type RegulatedFunds = {
  spendable: bigint;
  blacklisted: bigint;
  spendableUtxos: WalletSyncUtxo[];
  blacklistedUtxos: WalletSyncUtxo[];
};

export function classifyRegulatedFunds(
  snapshot: WalletSyncSnapshot,
  deployment: Deployment,
  policy: PolicySnapshot,
): RegulatedFunds {
  const blocked = new Set(policy.entries.map((entry) => `${entry.txid}:${entry.vout}`));
  const confirmed = snapshot.utxos.filter((utxo) =>
    utxo.source === "holder"
    && utxo.assetId === deployment.regulatedAsset
    && utxo.status === "confirmed"
  );
  const spendableUtxos: WalletSyncUtxo[] = [];
  const blacklistedUtxos: WalletSyncUtxo[] = [];
  let spendable = 0n;
  let blacklisted = 0n;

  for (const utxo of confirmed) {
    const amount = BigInt(utxo.amount);
    if (blocked.has(`${utxo.txid}:${utxo.vout}`)) {
      blacklistedUtxos.push(utxo);
      blacklisted += amount;
    } else {
      spendableUtxos.push(utxo);
      spendable += amount;
    }
  }

  return { spendable, blacklisted, spendableUtxos, blacklistedUtxos };
}

