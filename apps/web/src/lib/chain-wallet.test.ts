import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastTransaction, liveAnchorUtxo } from "./chain-wallet";
import type { Deployment } from "./domain";

const deployment = { network: "liquid-testnet" } as Deployment;

describe("chain wallet transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads raw anchor bytes without adding discovery requests", async () => {
    const request = vi.fn().mockResolvedValue(new Response("  abcd\n"));
    vi.stubGlobal("fetch", request);
    expect(await liveAnchorUtxo(deployment, "11".repeat(32), 2)).toEqual({
      txid: "11".repeat(32), vout: 2, transaction: "abcd", spendable: true,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `https://blockstream.info/liquidtestnet/api/tx/${"11".repeat(32)}/hex`,
      { cache: "no-store" },
    );
  });

  it("posts transaction bytes once and returns the trimmed txid", async () => {
    const request = vi.fn().mockResolvedValue(new Response("  txid\n"));
    vi.stubGlobal("fetch", request);
    expect(await broadcastTransaction(deployment, "abcd")).toBe("txid");
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "https://blockstream.info/liquidtestnet/api/tx",
      { cache: "no-store", method: "POST", headers: { "Content-Type": "text/plain" }, body: "abcd" },
    );
  });

  it("preserves bounded printable provider rejection details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" bad\ntransaction\u0001 ", { status: 400 })));
    const broadcast = broadcastTransaction(deployment, "abcd");
    await expect(broadcast).rejects.toThrow(
      "Esplora request failed (400) for https://blockstream.info/liquidtestnet/api/tx: bad transaction ",
    );
    const error = await broadcast.catch((caught: unknown) => caught);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
  });
});
