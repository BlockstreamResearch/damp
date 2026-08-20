import { z } from "zod";

import type { Deployment } from "./domain";

export const liquidTestnetEsploraUrl = "https://blockstream.info/liquidtestnet/api";
const MAX_ANCHOR_HOPS = 2_048;

const transactionStatusSchema = z.object({
  confirmed: z.boolean(),
  block_height: z.number().int().nonnegative().optional(),
  block_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const transactionSchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  vin: z.array(z.object({ txid: z.string().regex(/^[0-9a-f]{64}$/), vout: z.number().int().nonnegative() })),
  vout: z.array(z.object({
    scriptpubkey: z.string().regex(/^(?:[0-9a-f]{2})*$/),
    asset: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    value: z.number().int().nonnegative().optional(),
  })),
  status: transactionStatusSchema,
});

const outspendSchema = z.object({
  spent: z.boolean(),
  txid: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  vin: z.number().int().nonnegative().optional(),
  status: transactionStatusSchema.optional(),
});

export type AnchorPoint = {
  txid: string;
  vout: 0;
  scriptPubkey: string;
  blockHash?: string;
  blockHeight?: number;
  confirmations: number;
};

export type AnchorTraversal = {
  genesis: string;
  live: AnchorPoint;
  path: string[];
  tipHeight: number;
};

export type EsploraRequest = typeof fetch;

export class AnchorConflictError extends Error {
  readonly winningAnchor: AnchorTraversal;

  constructor(winningAnchor: AnchorTraversal) {
    super(`Verifier anchor changed to ${winningAnchor.live.txid}:0. Rebuild with the local AMP signer.`);
    this.name = "AnchorConflictError";
    this.winningAnchor = winningAnchor;
  }
}

export function esploraUrlForDeployment(deployment: Pick<Deployment, "network">): string {
  if (deployment.network === "liquid-testnet") return liquidTestnetEsploraUrl;
  const configured = localStorage.getItem("simplicity-amp:regtest-esplora")?.trim();
  if (!configured) {
    throw new Error("Configure an Elements regtest Esplora URL before importing this deployment.");
  }
  return configured.replace(/\/$/, "");
}

/**
 * Follow the unique verifier token from the manifest's genesis outpoint to the current unspent
 * output. Every transition is checked against the v0.1 index convention and the fixed verifier
 * asset/value. The chain, rather than GitHub, decides which conflicting anchor spend won.
 */
export async function traverseLiveAnchor(
  deployment: Pick<Deployment, "genesisAnchor" | "verifierAsset" | "verifierAssetAmount">,
  esploraUrl: string,
  request: EsploraRequest = fetch,
): Promise<AnchorTraversal> {
  const [genesisTxid, genesisVoutText] = deployment.genesisAnchor.split(":");
  const genesisVout = Number(genesisVoutText);
  if (genesisVout !== 0) throw new Error("AMP v0.1 requires the genesis verifier anchor at output 0.");

  const baseUrl = esploraUrl.replace(/\/$/, "");
  const tipHeight = await getTextNumber(request, `${baseUrl}/blocks/tip/height`);
  const path: string[] = [];
  const visited = new Set<string>();
  let currentTxid = genesisTxid;

  for (let hop = 0; hop < MAX_ANCHOR_HOPS; hop += 1) {
    const outpoint = `${currentTxid}:0`;
    if (visited.has(outpoint)) throw new Error("Verifier anchor traversal contains a cycle.");
    visited.add(outpoint);
    path.push(outpoint);

    const transaction = transactionSchema.parse(await getJson(request, `${baseUrl}/tx/${currentTxid}`));
    if (transaction.txid !== currentTxid) throw new Error("Esplora returned a transaction with the wrong txid.");
    validateAnchorOutput(transaction.vout[0], deployment);

    const outspend = outspendSchema.parse(await getJson(request, `${baseUrl}/tx/${currentTxid}/outspend/0`));
    if (!outspend.spent) {
      return {
        genesis: deployment.genesisAnchor,
        live: {
          txid: currentTxid,
          vout: 0,
          scriptPubkey: transaction.vout[0].scriptpubkey,
          blockHash: transaction.status.block_hash,
          blockHeight: transaction.status.block_height,
          confirmations: confirmationsAtTip(transaction.status, tipHeight),
        },
        path,
        tipHeight,
      };
    }

    if (!outspend.txid || outspend.vin !== 0) {
      throw new Error("The winning verifier spend does not consume the anchor at input 0.");
    }
    const spender = transactionSchema.parse(await getJson(request, `${baseUrl}/tx/${outspend.txid}`));
    const primaryInput = spender.vin[0];
    if (!primaryInput || primaryInput.txid !== currentTxid || primaryInput.vout !== 0) {
      throw new Error("The reported anchor spender does not reference the current anchor at input 0.");
    }
    validateAnchorOutput(spender.vout[0], deployment);
    currentTxid = spender.txid;
  }

  throw new Error(`Verifier anchor traversal exceeded ${MAX_ANCHOR_HOPS} transactions.`);
}

export function anchorChanged(previous: AnchorPoint, next: AnchorPoint): boolean {
  return previous.txid !== next.txid || previous.vout !== next.vout || previous.blockHash !== next.blockHash;
}

/** Re-read chain truth immediately before signing and reject a stale browser build. */
export async function requireFreshAnchor(
  deployment: Pick<Deployment, "genesisAnchor" | "verifierAsset" | "verifierAssetAmount">,
  expected: AnchorPoint,
  esploraUrl: string,
  request: EsploraRequest = fetch,
): Promise<AnchorTraversal> {
  const winning = await traverseLiveAnchor(deployment, esploraUrl, request);
  if (anchorChanged(expected, winning.live)) throw new AnchorConflictError(winning);
  return winning;
}

function validateAnchorOutput(
  output: z.infer<typeof transactionSchema>["vout"][number] | undefined,
  deployment: Pick<Deployment, "verifierAsset" | "verifierAssetAmount">,
) {
  if (!output) throw new Error("Verifier transaction has no output 0.");
  if (output.scriptpubkey.length === 0) throw new Error("Verifier output 0 cannot be a fee output.");
  if (output.asset !== deployment.verifierAsset) {
    throw new Error("Verifier output 0 does not carry the deployment's explicit verifier asset.");
  }
  if (output.value !== deployment.verifierAssetAmount) {
    throw new Error("Verifier output 0 must carry exactly one explicit verifier base unit.");
  }
}

function confirmationsAtTip(status: z.infer<typeof transactionStatusSchema>, tipHeight: number) {
  if (!status.confirmed || status.block_height === undefined) return 0;
  return Math.max(0, tipHeight - status.block_height + 1);
}

async function getJson(request: EsploraRequest, url: string): Promise<unknown> {
  const response = await request(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Esplora request failed (${response.status}) for ${url}.`);
  return response.json();
}

async function getTextNumber(request: EsploraRequest, url: string): Promise<number> {
  const response = await request(url, { cache: "no-store", headers: { Accept: "text/plain" } });
  if (!response.ok) throw new Error(`Esplora request failed (${response.status}) for ${url}.`);
  const value = Number(await response.text());
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Esplora returned an invalid chain height.");
  return value;
}
