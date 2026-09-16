import { describe, expect, it, vi } from "vitest";
import { discoverIssuerTransactions, publicEsploraUrl } from "./audit-issuer-history";
import type { DeploymentManifest } from "./domain";

vi.mock("./damp-signer", () => ({ inspectPublicTransaction: vi.fn() }));
const hash = (n: number) => n.toString(16).padStart(64, "0");
const deployment = { network: "elements-regtest", regulatedAsset: hash(99), genesisAnchor: `${hash(1)}:0` } as DeploymentManifest;
function provider(total = 28) {
  const ids = Array.from({ length: total }, (_, index) => hash(index + 1));
  const info = { asset_id: deployment.regulatedAsset, issuance_txin: { txid: hash(1) }, chain_stats: { tx_count: total, issuance_count: total - 1 }, mempool_stats: { issuance_count: 0 } };
  let infoCalls = 0;
  const state = { missing: false, duplicate: false, reorg: false, mismatch: false, pending: false, oversized: false };
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
    expect(init?.headers).toBeUndefined();
    const path = new URL(String(url)).pathname.replace('/api', '');
    if (path.startsWith('/block-height/')) return new Response(hash(888));
    if (path === '/blocks/tip/hash') return new Response(state.reorg && infoCalls > 1 ? hash(999) : hash(888));
    if (path === `/asset/${deployment.regulatedAsset}`) { infoCalls++; return Response.json({ ...info, mempool_stats: { issuance_count: state.pending ? 1 : 0 } }); }
    if (path.includes('/txs/chain')) {
      const after = path.split('/txs/chain')[1].slice(1);
      const start = after ? ids.indexOf(after) + 1 : 0;
      let page = ids.slice(start, start + 25);
      if (state.missing) page = [];
      if (state.duplicate && start) page = ids.slice(0, 2);
      return Response.json(page.map(txid => ({ txid, status: { confirmed: true, block_height: 1, block_hash: hash(888) } })));
    }
    if (path.endsWith('/hex')) return new Response(state.oversized ? "f".repeat(8_000_001) : path.split('/')[2]);
    throw new Error(`Unexpected public request ${path}`);
  }) as unknown as typeof fetch;
  const inspect = vi.fn(async (raw: string) => ({ txid: state.mismatch ? hash(123) : raw, inputs: [{ issuance: raw === ids[ids.length - 1] ? null : { asset: deployment.regulatedAsset, reissuance: raw !== hash(1) } }] }));
  return { state, info, request, inspect };
}

describe("automatic public issuer history", () => {
  it("paginates all asset events, calculates identities locally and excludes a burn-only transaction", async () => {
    const p = provider();
    const result = await discoverIssuerTransactions(deployment, "http://127.0.0.1:3002/api", p);
    expect(result).toHaveLength(27);
    expect(result[0]).toBe(hash(1));
    expect(p.inspect).toHaveBeenCalledTimes(28);
  });
  it.each(["missing", "duplicate", "reorg", "mismatch", "pending"] as const)("rejects %s history without a partial export", async failure => {
    const p = provider(); p.state[failure] = true;
    await expect(discoverIssuerTransactions(deployment, "https://example.com/api", p)).rejects.toThrow(/incomplete or changed/);
  });
  it("rejects inconsistent issuance counts", async () => {
    const p = provider(); p.info.chain_stats.issuance_count++;
    await expect(discoverIssuerTransactions(deployment, "https://example.com/api", p)).rejects.toThrow(/incomplete or changed/);
  });
  it("directs histories above the browser limit to native export before fetching transactions", async () => {
    const p = provider(); p.info.chain_stats.tx_count = 1025;
    await expect(discoverIssuerTransactions(deployment, "https://example.com/api", p)).rejects.toThrow(/1024-event browser limit.*native export/);
    expect(p.inspect).not.toHaveBeenCalled();
    expect(p.request).toHaveBeenCalledTimes(3);
  });
  it("rejects oversized raw data before inspection", async () => {
    const p = provider(); p.state.oversized = true;
    await expect(discoverIssuerTransactions(deployment, "https://example.com/api", p)).rejects.toThrow(/allowance/);
    expect(p.inspect).not.toHaveBeenCalled();
  });
  it("rejects wrong testnet genesis", async () => {
    await expect(discoverIssuerTransactions({ ...deployment, network: "liquid-testnet" }, "https://example.com/api", provider())).rejects.toThrow(/different network/);
  });
  it("makes provider access failures actionable without reflecting remote text", async () => {
    const p = provider(); p.request = vi.fn(async () => new Response("untrusted failure body", { status: 503 }));
    await expect(discoverIssuerTransactions(deployment, "https://example.com/api", p)).rejects.toThrow(/Check its URL/);
  });
  it.each(["http://remote.example/api", "https://user:pass@example.com", "https://example.com?token=secret", "https://example.com/#fragment"])("rejects unsafe URL %s before any fetch", async url => {
    const p = provider();
    await expect(discoverIssuerTransactions(deployment, url, p)).rejects.toThrow(/Use HTTPS/);
    expect(p.request).not.toHaveBeenCalled();
  });
  it("normalizes a public URL", () => expect(publicEsploraUrl(" https://example.com/api/ ")).toBe("https://example.com/api"));
});
