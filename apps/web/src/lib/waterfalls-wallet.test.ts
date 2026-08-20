import { Buffer } from "buffer";
import { address as liquidAddress, networks, Transaction } from "liquidjs-lib";
import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({
  getWalletSyncRecord: () => Promise.resolve(undefined),
  putWalletSyncRecord: () => Promise.resolve(),
  listReceiveRecords: () => Promise.resolve([]),
  putReceiveRecord: () => Promise.resolve(),
}));

import {
  discoverWalletSnapshot,
  scanWaterfallsAddress,
  walletDiscoveryLimits,
  WalletDiscoveryCancelledError,
  WalletDiscoverySafetyError,
  type WalletSyncAddress,
} from "./wallet-sync";
import { walletDiscoverySource } from "./wallet-source";

const txid = "ab".repeat(32);
const blockHash = "cd".repeat(32);

function fixtureAddress(): { address: WalletSyncAddress; unconfidential: string } {
  const unconfidential = liquidAddress.toBech32(Buffer.alloc(20, 7), 0, networks.testnet.bech32);
  const confidentialAddress = liquidAddress.toConfidential(unconfidential, Buffer.from(`02${"11".repeat(32)}`, "hex"));
  return {
    unconfidential,
    address: {
      source: "wallet",
      branch: 0,
      index: 0,
      confidentialAddress,
      scriptPubkey: liquidAddress.toOutputScript(unconfidential, networks.testnet).toString("hex"),
      hasActivity: false,
    },
  };
}

function derivedAddress(branch: 0 | 1, index: number) {
  const program = Buffer.alloc(20, branch + 1);
  program.writeUInt32BE(index, 16);
  const unconfidential = liquidAddress.toBech32(program, 0, networks.testnet.bech32);
  return {
    sdk: "test",
    branch,
    index,
    derivationPath: `m/${branch}/${index}`,
    confidentialAddress: liquidAddress.toConfidential(unconfidential, Buffer.from(`02${"11".repeat(32)}`, "hex")),
    scriptPubkey: liquidAddress.toOutputScript(unconfidential, networks.testnet).toString("hex"),
  };
}

function waterfallsBody(
  entries: unknown[],
  options: { page?: number; hash?: string; hasMore?: string[] } = {},
) {
  return {
    txs_seen: { addresses: [entries] },
    page: options.page ?? 0,
    ...(options.hasMore ? { has_more: options.hasMore } : {}),
    tip_meta: { b: options.hash ?? blockHash, t: 1_787_222_831, h: 2_581_109 },
  };
}

describe("Waterfalls Liquid testnet wallet discovery", () => {
  it("maps positional v4 history and UTXOs, including confirmation metadata", async () => {
    const { address, unconfidential } = fixtureAddress();
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("addresses")).toBe(unconfidential);
      const utxoOnly = url.searchParams.get("utxo_only") === "true";
      return Response.json(waterfallsBody(utxoOnly
        ? [{ txid, height: 2_581_100, block_hash: blockHash, timestamp: 1_787_222_000, v: 3 }]
        : [
            { txid, height: 2_581_100, block_hash: blockHash, timestamp: 1_787_222_000, v: 3 },
            { txid: "ef".repeat(32), height: 2_581_101, block_hash: blockHash, timestamp: 1_787_222_100, v: -1 },
          ]));
    });

    const result = await scanWaterfallsAddress(walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>, address, request);

    expect(result).toMatchObject({
      hasActivity: true,
      historyComplete: true,
      tipHash: blockHash,
      tipHeight: 2_581_109,
      utxos: [{ txid, vout: 2, status: { confirmed: true, block_height: 2_581_100, block_hash: blockHash } }],
    });
    expect(result.historyTxids).toEqual([txid, "ef".repeat(32)].sort());
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Waterfalls changes tips between history and UTXO views", async () => {
    const { address } = fixtureAddress();
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return Response.json(waterfallsBody(
        [{ txid, height: 0, block_hash: null, timestamp: null, v: 1 }],
        { hash: url.searchParams.has("utxo_only") ? "12".repeat(32) : blockHash },
      ));
    });

    await expect(scanWaterfallsAddress(
      walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>,
      address,
      request,
    )).rejects.toThrow("chain tip changed");
  });

  it("rejects a coherent-tip fallback that omits a Waterfalls-proven output", async () => {
    const { address, unconfidential } = fixtureAddress();
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.origin === new URL(source.utxoFallbackUrl).origin) {
        if (url.pathname.endsWith("/blocks/tip/hash")) return new Response(blockHash);
        if (url.pathname.endsWith(`/block/${blockHash}`)) return Response.json({ id: blockHash, height: 2_581_109 });
        return Response.json([]);
      }
      const page = Number(url.searchParams.get("page"));
      return Response.json(waterfallsBody(
        [{ txid, height: 0, block_hash: null, timestamp: null, v: 1 }],
        { page, hasMore: page === 0 ? [unconfidential] : undefined },
      ));
    });

    await expect(scanWaterfallsAddress(source, address, request)).rejects.toThrow(
      "omitted Waterfalls-proven fallback output",
    );
    expect(request.mock.calls.some(([input]) => String(input).includes("utxo_only=true"))).toBe(false);
    expect(request.mock.calls.some(([input]) => String(input).includes("/scripthash/") && String(input).endsWith("/utxo"))).toBe(true);
  });

  it("accepts an empty coherent fallback after Waterfalls proves the output was spent", async () => {
    const { address, unconfidential } = fixtureAddress();
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const spending = Transaction.fromHex(`020000000001${Buffer.from(txid, "hex").reverse().toString("hex")}0200000000ffffffff0000000000`);
    const spendingTxid = spending.getId();
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.origin === new URL(source.utxoFallbackUrl).origin) {
        if (url.pathname.endsWith("/blocks/tip/hash")) return new Response(blockHash);
        if (url.pathname.endsWith(`/block/${blockHash}`)) return Response.json({ id: blockHash, height: 2_581_109 });
        return Response.json([]);
      }
      if (url.pathname.endsWith(`/tx/${spendingTxid}/raw`)) {
        return new Response(Buffer.from(spending.toHex(), "hex"));
      }
      const page = Number(url.searchParams.get("page"));
      return Response.json(waterfallsBody([
        { txid, height: 2_581_100, block_hash: blockHash, timestamp: 1_787_222_000, v: 3 },
        { txid: spendingTxid, height: 0, block_hash: null, timestamp: null, v: -1 },
      ], { page, hasMore: page === 0 ? [unconfidential] : undefined }));
    });

    await expect(scanWaterfallsAddress(source, address, request)).resolves.toMatchObject({
      hasActivity: true,
      utxos: [],
    });
  });

  it("accepts a paginated fallback only when the tip and output proof match Waterfalls", async () => {
    const { address, unconfidential } = fixtureAddress();
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const outputHeight = 2_581_100;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.origin === new URL(source.utxoFallbackUrl).origin) {
        if (url.pathname.endsWith("/blocks/tip/hash")) return new Response(blockHash);
        if (url.pathname.endsWith(`/block/${blockHash}`)) return Response.json({ id: blockHash, height: 2_581_109 });
        return Response.json([{ txid, vout: 2, status: { confirmed: true, block_height: outputHeight, block_hash: blockHash } }]);
      }
      const page = Number(url.searchParams.get("page"));
      return Response.json(waterfallsBody(
        [{ txid, height: outputHeight, block_hash: blockHash, timestamp: 1_787_222_000, v: 3 }],
        { page, hasMore: page === 0 ? [unconfidential] : undefined },
      ));
    });

    await expect(scanWaterfallsAddress(source, address, request)).resolves.toMatchObject({
      utxos: [{ txid, vout: 2, status: { confirmed: true, block_height: outputHeight, block_hash: blockHash } }],
    });
  });

  it("rejects a fallback that omits one of several Waterfalls-proven outputs", async () => {
    const { address, unconfidential } = fixtureAddress();
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const secondTxid = "ef".repeat(32);
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.origin === new URL(source.utxoFallbackUrl).origin) {
        if (url.pathname.endsWith("/blocks/tip/hash")) return new Response(blockHash);
        if (url.pathname.endsWith(`/block/${blockHash}`)) return Response.json({ id: blockHash, height: 2_581_109 });
        return Response.json([{ txid, vout: 0, status: { confirmed: true, block_height: 2_581_100, block_hash: blockHash } }]);
      }
      const page = Number(url.searchParams.get("page"));
      return Response.json(waterfallsBody([
        { txid, height: 2_581_100, block_hash: blockHash, timestamp: 1_787_222_000, v: 1 },
        { txid: secondTxid, height: 2_581_101, block_hash: blockHash, timestamp: 1_787_222_100, v: 2 },
      ], { page, hasMore: page === 0 ? [unconfidential] : undefined }));
    });

    await expect(scanWaterfallsAddress(source, address, request)).rejects.toThrow(
      `omitted Waterfalls-proven fallback output ${secondTxid}:1`,
    );
  });

  it("rejects a same-tip fallback output that Waterfalls history proves was spent", async () => {
    const { address, unconfidential } = fixtureAddress();
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const spending = Transaction.fromHex(`020000000001${Buffer.from(txid, "hex").reverse().toString("hex")}0200000000ffffffff0000000000`);
    const spendingTxid = spending.getId();
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.origin === new URL(source.utxoFallbackUrl).origin) {
        if (url.pathname.endsWith("/blocks/tip/hash")) return new Response(blockHash);
        if (url.pathname.endsWith(`/block/${blockHash}`)) return Response.json({ id: blockHash, height: 2_581_109 });
        return Response.json([{ txid, vout: 2, status: { confirmed: true, block_height: 2_581_100, block_hash: blockHash } }]);
      }
      if (url.pathname.endsWith(`/tx/${spendingTxid}/raw`)) {
        return new Response(Buffer.from(spending.toHex(), "hex"));
      }
      const page = Number(url.searchParams.get("page"));
      return Response.json(waterfallsBody([
        { txid, height: 2_581_100, block_hash: blockHash, timestamp: 1_787_222_000, v: 3 },
        { txid: spendingTxid, height: 0, block_hash: null, timestamp: null, v: -1 },
      ], { page, hasMore: page === 0 ? [unconfidential] : undefined }));
    });

    await expect(scanWaterfallsAddress(source, address, request)).rejects.toThrow("was already spent");
  });

  it.each([
    {
      name: "future confirmation",
      fallbackTipHash: blockHash,
      fallbackTipHeight: 2_581_109,
      fallback: { txid, vout: 2, status: { confirmed: true, block_height: 9_999_999, block_hash: blockHash } },
      message: "above the shared chain tip",
    },
    {
      name: "stale provider tip",
      fallbackTipHash: blockHash,
      fallbackTipHeight: 2_581_108,
      fallback: { txid, vout: 2, status: { confirmed: true, block_height: 2_581_100, block_hash: blockHash } },
      message: "different chain tips",
    },
    {
      name: "reorged provider tip",
      fallbackTipHash: "de".repeat(32),
      fallbackTipHeight: 2_581_109,
      fallback: { txid, vout: 2, status: { confirmed: true, block_height: 2_581_100, block_hash: blockHash } },
      message: "different chain tips",
    },
    {
      name: "missing Waterfalls output proof",
      fallbackTipHash: blockHash,
      fallbackTipHeight: 2_581_109,
      fallback: { txid: "ef".repeat(32), vout: 2, status: { confirmed: true, block_height: 2_581_100, block_hash: blockHash } },
      message: "did not prove fallback output",
    },
    {
      name: "confirmation disagreement",
      fallbackTipHash: blockHash,
      fallbackTipHeight: 2_581_109,
      fallback: { txid, vout: 2, status: { confirmed: true, block_height: 2_581_101, block_hash: blockHash } },
      message: "disagreed about fallback output",
    },
  ])("rejects $name in a paginated fallback", async ({ fallbackTipHash, fallbackTipHeight, fallback, message }) => {
    const { address, unconfidential } = fixtureAddress();
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.origin === new URL(source.utxoFallbackUrl).origin) {
        if (url.pathname.endsWith("/blocks/tip/hash")) return new Response(fallbackTipHash);
        if (url.pathname.endsWith(`/block/${fallbackTipHash}`)) return Response.json({ id: fallbackTipHash, height: fallbackTipHeight });
        return Response.json([fallback]);
      }
      const page = Number(url.searchParams.get("page"));
      return Response.json(waterfallsBody(
        [{ txid, height: 2_581_100, block_hash: blockHash, timestamp: 1_787_222_000, v: 3 }],
        { page, hasMore: page === 0 ? [unconfidential] : undefined },
      ));
    });

    await expect(scanWaterfallsAddress(source, address, request)).rejects.toThrow(message);
  });

  it("bounds endless paginated activity across the complete wallet scan", async () => {
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.origin === new URL(source.utxoFallbackUrl).origin) {
        if (url.pathname.endsWith("/blocks/tip/hash")) return new Response(blockHash);
        if (url.pathname.endsWith(`/block/${blockHash}`)) return Response.json({ id: blockHash, height: 2_581_109 });
        return Response.json([{ txid, vout: 0, status: { confirmed: false } }]);
      }
      const requested = url.searchParams.get("addresses")!;
      const page = Number(url.searchParams.get("page"));
      return Response.json(waterfallsBody(
        [{ txid, height: 0, block_hash: null, timestamp: null, v: 1 }],
        { page, hasMore: page < 19 ? [requested] : undefined },
      ));
    });

    await expect(discoverWalletSnapshot({
      fingerprint: "aabbccdd",
      network: "liquid-testnet",
      scope: "base",
      source,
      gapLimit: 1,
      request,
      dependencies: { deriveAddress: (branch, index) => Promise.resolve(derivedAddress(branch, index)) },
    })).rejects.toMatchObject({ code: "WALLET_DISCOVERY_SAFETY_LIMIT", limit: "fallback-requests" });
    expect(request.mock.calls.length).toBeLessThanOrEqual(walletDiscoveryLimits.maxRequests);
  });

  it("counts repeated history entries globally instead of only unique txids", async () => {
    const { address, unconfidential } = fixtureAddress();
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const repeated = Array.from({ length: 1_000 }, () => ({ txid, height: 0, block_hash: null, timestamp: null, v: 1 }));
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return Response.json(waterfallsBody(repeated, {
        page: Number(url.searchParams.get("page")),
        hasMore: [unconfidential],
      }));
    });

    await expect(scanWaterfallsAddress(source, address, request)).rejects.toMatchObject({
      code: "WALLET_DISCOVERY_SAFETY_LIMIT",
      limit: "history-entries",
    } satisfies Partial<WalletDiscoverySafetyError>);
    expect(request.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it("cancels in-flight address requests and never starts queued scans", async () => {
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const controller = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const request = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      if (request.mock.calls.length === 8) startedResolve();
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const discovery = discoverWalletSnapshot({
      fingerprint: "aabbccdd",
      network: "liquid-testnet",
      scope: "base",
      source,
      signal: controller.signal,
      request,
      dependencies: { deriveAddress: (branch, index) => Promise.resolve(derivedAddress(branch, index)) },
    });

    await started;
    controller.abort();
    await expect(discovery).rejects.toBeInstanceOf(WalletDiscoveryCancelledError);
    expect(request).toHaveBeenCalledTimes(8);
  });

  it("aborts concurrent sibling requests when one provider response fails", async () => {
    const source = walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>;
    const signals: AbortSignal[] = [];
    const request = vi.fn<typeof fetch>((_input, init) => {
      if (request.mock.calls.length === 1) return Promise.resolve(new Response("not-json"));
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });

    await expect(discoverWalletSnapshot({
      fingerprint: "aabbccdd",
      network: "liquid-testnet",
      scope: "base",
      source,
      request,
      dependencies: { deriveAddress: (branch, index) => Promise.resolve(derivedAddress(branch, index)) },
    })).rejects.toBeInstanceOf(Error);

    expect(request).toHaveBeenCalledTimes(8);
    expect(signals).toHaveLength(7);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("does not abort provider request signals after a successful scan", async () => {
    const { address } = fixtureAddress();
    const signals: AbortSignal[] = [];
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return Response.json(waterfallsBody([]));
    });

    await expect(scanWaterfallsAddress(
      walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>,
      address,
      request,
    )).resolves.toMatchObject({ hasActivity: false, utxos: [] });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(false);
  });

  it("rejects an input record in a Waterfalls UTXO-only response", async () => {
    const { address } = fixtureAddress();
    const request = vi.fn<typeof fetch>(async (input) => {
      const utxoOnly = new URL(String(input)).searchParams.has("utxo_only");
      return Response.json(waterfallsBody([
        { txid, height: 0, block_hash: null, timestamp: null, v: utxoOnly ? -1 : 1 },
      ]));
    });

    await expect(scanWaterfallsAddress(
      walletDiscoverySource("liquid-testnet") as Extract<ReturnType<typeof walletDiscoverySource>, { provider: "waterfalls-v4" }>,
      address,
      request,
    )).rejects.toThrow("contained an input record");
  });
});
