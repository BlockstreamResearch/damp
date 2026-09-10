import { describe, expect, it } from "vitest";

import { liquidTestnetEsploraUrl } from "./esplora";
import { liquidTestnetWaterfallsBackupUrl, liquidTestnetWaterfallsUrl, walletDiscoverySource } from "./wallet-source";

describe("wallet discovery provider selection", () => {
  it("preserves the primary Waterfalls endpoint and configures its backup separately from Esplora", () => {
    expect(walletDiscoverySource("liquid-testnet")).toEqual({
      provider: "waterfalls-v4",
      baseUrl: liquidTestnetWaterfallsUrl,
      backupBaseUrl: liquidTestnetWaterfallsBackupUrl,
      outspendFallbackUrl: liquidTestnetEsploraUrl,
      utxoFallbackUrl: liquidTestnetEsploraUrl,
    });
    expect(liquidTestnetWaterfallsUrl).toBe("https://waterfalls.liquidwebwallet.org/liquidtestnet/api");
    expect(liquidTestnetWaterfallsBackupUrl).toBe("https://waterfalls-elements-testnet.esplora.staging.blockstream.io:17771");
  });

  it("uses only the configured local Esplora for Elements regtest", () => {
    localStorage.setItem("simplicity-damp:regtest-esplora", "http://127.0.0.1:3001/api/");
    expect(walletDiscoverySource("elements-regtest")).toEqual({
      provider: "esplora",
      baseUrl: "http://127.0.0.1:3001/api",
    });
  });
});
