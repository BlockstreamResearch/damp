import { describe, expect, it } from "vitest";

import { liquidTestnetEsploraUrl } from "./esplora";
import { liquidTestnetWaterfallsUrl, walletDiscoverySource } from "./wallet-source";

describe("wallet discovery provider selection", () => {
  it("pins Liquid testnet discovery to Waterfalls with narrow Esplora fallbacks", () => {
    expect(walletDiscoverySource("liquid-testnet")).toEqual({
      provider: "waterfalls-v4",
      baseUrl: liquidTestnetWaterfallsUrl,
      outspendFallbackUrl: liquidTestnetEsploraUrl,
      utxoFallbackUrl: liquidTestnetEsploraUrl,
    });
  });

  it("uses only the configured local Esplora for Elements regtest", () => {
    localStorage.setItem("simplicity-amp:regtest-esplora", "http://127.0.0.1:3001/api/");
    expect(walletDiscoverySource("elements-regtest")).toEqual({
      provider: "esplora",
      baseUrl: "http://127.0.0.1:3001/api",
    });
  });
});
