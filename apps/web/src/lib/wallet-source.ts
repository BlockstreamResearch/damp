import type { SignerNetwork } from "./damp-signer";
import { esploraUrlForDeployment, liquidTestnetEsploraUrl } from "./esplora";

export const liquidTestnetWaterfallsUrl = "https://waterfalls.liquidwebwallet.org/liquidtestnet/api";
export const liquidTestnetWaterfallsBackupUrl = "https://waterfalls-elements-testnet.esplora.staging.blockstream.io:17771";

export type WalletDiscoverySource =
  | {
      provider: "waterfalls-v4";
      baseUrl: string;
      backupBaseUrl?: string;
      outspendFallbackUrl: string;
      utxoFallbackUrl: string;
    }
  | { provider: "esplora"; baseUrl: string };

/**
 * Liquid testnet wallet discovery is deliberately pinned to the public
 * Waterfalls test service documented by LWK, with a separate Waterfalls backup.
 * Regtest keeps the user's local Esplora; it has no shared Waterfalls chain.
 */
export function walletDiscoverySource(network: SignerNetwork): WalletDiscoverySource {
  if (network === "liquid-testnet") {
    return {
      provider: "waterfalls-v4",
      baseUrl: liquidTestnetWaterfallsUrl,
      backupBaseUrl: liquidTestnetWaterfallsBackupUrl,
      outspendFallbackUrl: liquidTestnetEsploraUrl,
      utxoFallbackUrl: liquidTestnetEsploraUrl,
    };
  }
  return { provider: "esplora", baseUrl: esploraUrlForDeployment({ network }) };
}
