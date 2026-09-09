import type { Deployment } from "./domain";
import type { Utxo } from "./damp-signer";
import { esploraUrlForDeployment } from "./esplora";
import { getEsploraText as fetchText } from "./esplora-client";

export async function liveAnchorUtxo(
  deployment: Deployment,
  txid: string,
  vout = 0,
): Promise<Utxo> {
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
