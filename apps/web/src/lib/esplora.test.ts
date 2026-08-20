import { describe, expect, it } from "vitest";

import { AnchorConflictError, anchorChanged, requireFreshAnchor, traverseLiveAnchor } from "./esplora";

const genesis = "1".repeat(64);
const winner = "2".repeat(64);
const verifierAsset = "a".repeat(64);
const deployment = {
  genesisAnchor: `${genesis}:0`,
  verifierAsset,
  verifierAssetAmount: 1 as const,
};

function transaction(txid: string, previous?: string, blockHeight = 99) {
  return {
    txid,
    vin: previous ? [{ txid: previous, vout: 0 }] : [],
    vout: [{ scriptpubkey: "5120" + "b".repeat(64), asset: verifierAsset, value: 1 }],
    status: { confirmed: true, block_height: blockHeight, block_hash: "c".repeat(64) },
  };
}

function mockEsplora(values: Record<string, unknown>): typeof fetch {
  return (async (input) => {
    const url = String(input);
    const value = values[url];
    if (value === undefined) return new Response("missing", { status: 404 });
    if (typeof value === "string") return new Response(value);
    return Response.json(value);
  }) as typeof fetch;
}

describe("verifier anchor traversal", () => {
  it("follows the winning input-0 spend and reports confirmations", async () => {
    const request = mockEsplora({
      "https://node/blocks/tip/height": "100",
      [`https://node/tx/${genesis}`]: transaction(genesis, undefined, 90),
      [`https://node/tx/${genesis}/outspend/0`]: { spent: true, txid: winner, vin: 0 },
      [`https://node/tx/${winner}`]: transaction(winner, genesis, 99),
      [`https://node/tx/${winner}/outspend/0`]: { spent: false },
    });

    const result = await traverseLiveAnchor(deployment, "https://node/", request);
    expect(result.path).toEqual([`${genesis}:0`, `${winner}:0`]);
    expect(result.live.txid).toBe(winner);
    expect(result.live.confirmations).toBe(2);
  });

  it("rejects a reported winner that did not spend the anchor at input 0", async () => {
    const request = mockEsplora({
      "https://node/blocks/tip/height": "100",
      [`https://node/tx/${genesis}`]: transaction(genesis),
      [`https://node/tx/${genesis}/outspend/0`]: { spent: true, txid: winner, vin: 1 },
    });

    await expect(traverseLiveAnchor(deployment, "https://node", request)).rejects.toThrow("input 0");
  });

  it("rejects verifier-asset substitution", async () => {
    const wrong = transaction(genesis);
    wrong.vout[0].asset = "d".repeat(64);
    const request = mockEsplora({
      "https://node/blocks/tip/height": "100",
      [`https://node/tx/${genesis}`]: wrong,
    });

    await expect(traverseLiveAnchor(deployment, "https://node", request)).rejects.toThrow("verifier asset");
  });

  it("treats a replacement or block-hash change as a rebuild condition", () => {
    const previous = { txid: genesis, vout: 0 as const, scriptPubkey: "51", blockHash: "a".repeat(64), confirmations: 1 };
    expect(anchorChanged(previous, { ...previous })).toBe(false);
    expect(anchorChanged(previous, { ...previous, txid: winner })).toBe(true);
    expect(anchorChanged(previous, { ...previous, blockHash: "b".repeat(64) })).toBe(true);
  });

  it("forces a rebuild when a competing transaction wins before signing", async () => {
    const request = mockEsplora({
      "https://node/blocks/tip/height": "100",
      [`https://node/tx/${genesis}`]: transaction(genesis),
      [`https://node/tx/${genesis}/outspend/0`]: { spent: true, txid: winner, vin: 0 },
      [`https://node/tx/${winner}`]: transaction(winner, genesis),
      [`https://node/tx/${winner}/outspend/0`]: { spent: false },
    });
    const expected = { txid: genesis, vout: 0 as const, scriptPubkey: "51", confirmations: 1 };

    await expect(requireFreshAnchor(deployment, expected, "https://node", request)).rejects.toBeInstanceOf(
      AnchorConflictError,
    );
  });
});
