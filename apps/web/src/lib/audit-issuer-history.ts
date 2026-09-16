import { z } from "zod";
import type { DeploymentManifest } from "./domain";
import { inspectPublicTransaction } from "./damp-signer";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stats = z.object({ tx_count: count, issuance_count: count });
const assetInfo = z.object({
  asset_id: hash,
  issuance_txin: z.object({ txid: hash }),
  chain_stats: stats,
  mempool_stats: z.object({ issuance_count: z.number().int().nonnegative() }),
});
const transaction = z.object({
  txid: hash,
  status: z.object({ confirmed: z.literal(true), block_height: z.number().int().nonnegative(), block_hash: hash }),
});
const allowance = 24 * 1024 * 1024;
const retry = "Public issuance history is incomplete or changed. Retry discovery after the provider has synced; no credentials were exported.";

export function publicEsploraUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter the public Esplora API URL for this chain."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash)
    throw new Error("Use HTTPS or loopback HTTP, with no credentials, query or fragment in the Esplora URL.");
  return url.href.replace(/\/$/, "");
}

/** Public GETs only. Completeness trusts Esplora inclusion data, with counts and a stable tip checked. */
export async function discoverIssuerTransactions(deployment: DeploymentManifest, provider: string, options: {
  signal?: AbortSignal;
  progress?: (message: string) => void;
  request?: typeof fetch;
  inspect?: typeof inspectPublicTransaction;
} = {}): Promise<string[]> {
  const base = publicEsploraUrl(provider);
  const request = options.request ?? fetch;
  const inspect = options.inspect ?? inspectPublicTransaction;
  const deadline = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let received = 0;
  async function read(path: string, limit: number): Promise<string> {
    const response = await request(`${base}${path}`, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (!response.ok || !response.body) throw new Error("Public Esplora is unavailable. Check its URL, browser access and chain synchronization, then retry. Offline export is available below.");
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        received += next.value.length;
        if (bytes > limit || received > allowance) throw new Error("Public history exceeds the 24 MiB browser allowance. Use the offline export below.");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(output).trim();
  }
  try {
    options.progress?.("Checking public provider and issuance history…");
    const genesis = hash.parse(await read("/block-height/0", 128));
    if (deployment.network === "liquid-testnet" && genesis !== "a771da8e52ee6ad581ed1e9a99825e5b3b7992225534eaa2ae23244fe26ab1c1")
      throw new Error("The public provider is on a different network. Select the deployment's Liquid testnet provider.");
    const tip = hash.parse(await read("/blocks/tip/hash", 128));
    const path = `/asset/${deployment.regulatedAsset}`;
    const info = assetInfo.parse(JSON.parse(await read(path, 64 * 1024)));
    if (info.chain_stats.tx_count > 1024 || info.chain_stats.issuance_count > 1024)
      throw new Error("Public issuance and burn history exceeds the 1024-event browser limit. Use the native export command in the offline guide below.");
    const bootstrap = deployment.genesisAnchor.split(":")[0];
    if (info.asset_id !== deployment.regulatedAsset || info.issuance_txin.txid !== bootstrap || info.chain_stats.issuance_count < 1 || info.mempool_stats.issuance_count !== 0) throw new Error(retry);
    const seen = new Set<string>();
    const blocks = new Map<number, string>();
    const raws: string[] = [];
    let last = "";
    let sawBootstrap = false;
    while (true) {
      signal.throwIfAborted();
      const page = z.array(transaction).max(25).parse(JSON.parse(await read(`${path}/txs/chain${last ? `/${last}` : ""}`, 2 * 1024 * 1024)));
      if (!page.length) break;
      for (const item of page) {
        if (seen.has(item.txid) || seen.size >= info.chain_stats.tx_count) throw new Error(retry);
        seen.add(item.txid);
        const knownBlock = blocks.get(item.status.block_height);
        if (knownBlock && knownBlock !== item.status.block_hash) throw new Error(retry);
        if (!knownBlock) {
          if (await read(`/block-height/${item.status.block_height}`, 128) !== item.status.block_hash) throw new Error(retry);
          blocks.set(item.status.block_height, item.status.block_hash);
        }
        options.progress?.(`Validating public transaction ${seen.size} of ${info.chain_stats.tx_count}…`);
        const raw = await read(`/tx/${item.txid}/hex`, 8_000_000);
        const decoded = await inspect(raw);
        if (decoded.txid !== item.txid) throw new Error(retry);
        const issuances = decoded.inputs.filter(input => input.issuance?.asset === deployment.regulatedAsset);
        if (item.txid === bootstrap) {
          if (!issuances.some(input => input.issuance?.reissuance === false)) throw new Error(retry);
          sawBootstrap = true;
        }
        if (issuances.length) raws.push(raw);
      }
      last = page[page.length - 1].txid;
    }
    const end = assetInfo.parse(JSON.parse(await read(path, 64 * 1024)));
    if (!sawBootstrap || seen.size !== info.chain_stats.tx_count || raws.length !== info.chain_stats.issuance_count
        || JSON.stringify(end) !== JSON.stringify(info) || await read("/blocks/tip/hash", 128) !== tip) throw new Error(retry);
    return raws;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new Error(retry);
    if (error instanceof TypeError || signal.aborted || (error instanceof DOMException && error.name === "TimeoutError"))
      throw new Error("Public discovery could not finish. Check provider access and browser local-network permission, then retry or use the offline export below.");
    throw error;
  }
}
