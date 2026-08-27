import type { Deployment } from "./domain";

export type WalletAssetDetails = {
  label: string;
  ticker: string;
  precision: number;
};

const unknownAsset: WalletAssetDetails = {
  label: "Unknown asset",
  ticker: "base units",
  precision: 0,
};

export function createWalletAssetCatalog(deployments: readonly Deployment[]) {
  const catalog = new Map<string, WalletAssetDetails>();
  for (const deployment of deployments) {
    catalog.set(deployment.policyAsset, { label: "Liquid Bitcoin", ticker: "L-BTC", precision: 8 });
    if (deployment.reissuanceToken) {
      catalog.set(deployment.reissuanceToken, { label: `Reissuance token · ${deployment.asset.ticker}`, ticker: "TOKEN", precision: 0 });
    }
    catalog.set(deployment.regulatedAsset, { label: deployment.asset.name, ticker: deployment.asset.ticker, precision: deployment.asset.precision });
  }
  return catalog;
}

export function walletAssetDetails(catalog: ReadonlyMap<string, WalletAssetDetails>, assetId: string) {
  return catalog.get(assetId) ?? unknownAsset;
}
