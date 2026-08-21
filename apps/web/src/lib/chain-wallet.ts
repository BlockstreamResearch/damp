import type { Deployment } from "./domain";
import type { SpendableUtxo } from "./amp-signer";
import { esploraUrlForDeployment } from "./esplora";

async function fetchText(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().replace(/[^\x20-\x7e]/g, " ").slice(0, 512);
    throw new Error(`Esplora request failed (${response.status}) for ${url}${detail ? `: ${detail}` : "."}`);
  }
  return text;
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
