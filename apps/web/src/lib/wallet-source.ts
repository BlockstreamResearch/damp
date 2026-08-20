import type { SignerNetwork } from "./amp-signer";
import { esploraUrlForDeployment, liquidTestnetEsploraUrl } from "./esplora";

export const liquidTestnetWaterfallsUrl = "https://waterfalls.liquidwebwallet.org/liquidtestnet/api";

export type WalletDiscoverySource =
  | {
      provider: "waterfalls-v4";
      baseUrl: string;
      outspendFallbackUrl: string;
      utxoFallbackUrl: string;
    }
  | { provider: "esplora"; baseUrl: string };

/**
 * Liquid testnet wallet discovery is deliberately pinned to the public
 * Waterfalls test service documented by LWK. Regtest keeps the user's local
 * Esplora because there is no shared regtest Waterfalls chain.
 */
export function walletDiscoverySource(network: SignerNetwork): WalletDiscoverySource {
  if (network === "liquid-testnet") {
    return {
      provider: "waterfalls-v4",
      baseUrl: liquidTestnetWaterfallsUrl,
      outspendFallbackUrl: liquidTestnetEsploraUrl,
      utxoFallbackUrl: liquidTestnetEsploraUrl,
    };
  }
  return { provider: "esplora", baseUrl: esploraUrlForDeployment({ network }) };
}
