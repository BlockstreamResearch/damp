import { describe, expect, it } from "vitest";

import type { Deployment, PolicySnapshot } from "./domain";
import { classifyRegulatedFunds } from "./regulated-funds";
import type { WalletSyncSnapshot, WalletSyncUtxo } from "./wallet-sync";

const hash = (byte: string) => byte.repeat(64);
const deployment = {
  deploymentId: hash("a"),
  regulatedAsset: hash("b"),
} as Deployment;

function utxo(txid: string, amount: string, status: WalletSyncUtxo["status"] = "confirmed"): WalletSyncUtxo {
  return {
    source: "holder",
    txid,
    vout: 0,
    assetId: deployment.regulatedAsset,
    amount,
    status,
  } as WalletSyncUtxo;
}

describe("regulated fund classification", () => {
  it("separates current-policy blacklist entries from spendable confirmed funds", () => {
    const blocked = utxo(hash("1"), "25");
    const available = utxo(hash("2"), "75");
    const pending = utxo(hash("3"), "50", "unconfirmed");
    const snapshot = { utxos: [blocked, available, pending] } as WalletSyncSnapshot;
    const policy = { entries: [{ txid: blocked.txid, vout: blocked.vout }] } as PolicySnapshot;

    expect(classifyRegulatedFunds(snapshot, deployment, policy)).toEqual({
      spendable: 75n,
      blacklisted: 25n,
      spendableUtxos: [available],
      blacklistedUtxos: [blocked],
    });
  });
});
