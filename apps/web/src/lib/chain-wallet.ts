import { z } from "zod";

import type { Deployment, DeploymentManifest } from "./domain";
import {
  deriveWalletAddress,
  inspectUtxos,
  type InspectedUtxo,
  type SpendableUtxo,
} from "./amp-signer";
import { esploraUrlForDeployment } from "./esplora";
import type { StoredReceiveRecord } from "./store";

const utxoSchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  vout: z.number().int().nonnegative(),
  status: z.object({ confirmed: z.boolean() }),
});

async function scriptHash(scriptPubkey: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(scriptPubkey)) throw new Error("Invalid scriptPubKey hex.");
  const bytes = Uint8Array.from(scriptPubkey.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].reverse().map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchText(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) throw new Error(`Esplora request failed (${response.status}) for ${url}.`);
  return response.text();
}

export async function scanScriptUtxos(
  esploraUrl: string,
  scriptPubkey: string,
  locator: Pick<SpendableUtxo, "walletKey" | "holderKey"> = {},
) {
  const base = esploraUrl.replace(/\/$/, "");
  const hash = await scriptHash(scriptPubkey);
  const response = await fetch(`${base}/scripthash/${hash}/utxo`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Esplora UTXO scan failed (${response.status}).`);
  const listed = z.array(utxoSchema).parse(await response.json());
  const transactions = new Map<string, string>();
  await Promise.all([...new Set(listed.map(({ txid }) => txid))].map(async (txid) => {
    transactions.set(txid, (await fetchText(`${base}/tx/${txid}/hex`)).trim());
  }));
  return listed.map((utxo): SpendableUtxo => ({
    txid: utxo.txid,
    vout: utxo.vout,
    transaction: transactions.get(utxo.txid)!,
    spendable: utxo.status.confirmed,
    ...locator,
  }));
}

export async function scanWalletAt(
  esplora: string,
  gap = 10,
  network?: DeploymentManifest["network"],
) {
  const addresses = await Promise.all(
    [0, 1].flatMap((branch) =>
      Array.from({ length: gap }, (_, index) => deriveWalletAddress(branch, index, network)),
    ),
  );
  const groups = await Promise.all(addresses.map((address) =>
    scanScriptUtxos(esplora, address.scriptPubkey, {
      walletKey: { branch: address.branch, index: address.index },
    })
  ));
  return groups.flat();
}

export async function scanWalletUtxos(deployment: Deployment, gap = 10) {
  return scanWalletAt(esploraUrlForDeployment(deployment), gap, deployment.network);
}

export async function scanHolderUtxos(
  deployment: Deployment,
  records: StoredReceiveRecord[],
) {
  const esplora = esploraUrlForDeployment(deployment);
  const groups = await Promise.all(records.map(({ record, derivationIndex }) =>
    scanScriptUtxos(esplora, record.scriptPubkey, {
      holderKey: { derivationIndex, ownerPublicKey: record.ownerPublicKey },
    })
  ));
  return groups.flat();
}

export async function liveAnchorUtxo(
  deployment: Deployment,
  txid: string,
  vout = 0,
): Promise<SpendableUtxo> {
  const esplora = esploraUrlForDeployment(deployment).replace(/\/$/, "");
  return {
    txid,
    vout,
    transaction: (await fetchText(`${esplora}/tx/${txid}/hex`)).trim(),
    spendable: true,
  };
}

export async function inspectAndFilter(
  utxos: SpendableUtxo[],
  assetId: string,
): Promise<{ utxos: SpendableUtxo[]; inspected: InspectedUtxo[] }> {
  const confirmed = utxos.filter((utxo) => utxo.spendable);
  const inspected = await inspectUtxos(confirmed);
  const accepted = new Set(
    inspected
      .filter((utxo) => utxo.assetId === assetId)
      .map((utxo) => `${utxo.txid}:${utxo.vout}`),
  );
  return {
    utxos: confirmed.filter((utxo) => accepted.has(`${utxo.txid}:${utxo.vout}`)),
    inspected: inspected.filter((utxo) => accepted.has(`${utxo.txid}:${utxo.vout}`)),
  };
}

export async function findTokenUtxo(
  deployment: Deployment,
  walletUtxos: SpendableUtxo[],
) {
  if (!deployment.reissuanceToken) throw new Error("Deployment has no reissuance token.");
  const token = await inspectAndFilter(walletUtxos, deployment.reissuanceToken);
  const match = token.utxos[0];
  if (!match) throw new Error("The signer wallet has no confirmed reissuance token.");
  return match;
}

export async function broadcastTransaction(
  deployment: Pick<Deployment, "network">,
  transaction: string,
) {
  const base = esploraUrlForDeployment(deployment).replace(/\/$/, "");
  return (await fetchText(`${base}/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: transaction,
  })).trim();
}
