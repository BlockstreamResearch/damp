import { describe, expect, it } from "vitest";

import type { Deployment } from "./domain";
import { createWalletAssetCatalog, walletAssetDetails } from "./wallet-asset-catalog";

function deployment(ticker: string, regulatedAsset: string, reissuanceToken: string): Deployment {
  return {
    asset: { name: `${ticker} asset`, ticker, precision: ticker === "ONE" ? 2 : 6 },
    policyAsset: "aa".repeat(32),
    regulatedAsset,
    reissuanceToken,
  } as Deployment;
}

describe("wallet asset catalog", () => {
  it("resolves assets and tokens from every imported deployment", () => {
    const first = deployment("ONE", "11".repeat(32), "12".repeat(32));
    const second = deployment("TWO", "21".repeat(32), "22".repeat(32));
    const catalog = createWalletAssetCatalog([first, second]);

    expect(walletAssetDetails(catalog, first.regulatedAsset)).toEqual({ label: "ONE asset", ticker: "ONE", precision: 2 });
    expect(walletAssetDetails(catalog, second.regulatedAsset)).toEqual({ label: "TWO asset", ticker: "TWO", precision: 6 });
    expect(walletAssetDetails(catalog, first.reissuanceToken!)).toMatchObject({ label: "Reissuance token · ONE", ticker: "TOKEN" });
    expect(walletAssetDetails(catalog, first.policyAsset)).toEqual({ label: "Liquid Bitcoin", ticker: "L-BTC", precision: 8 });
  });

  it("keeps unrecognized assets explicit and unscaled", () => {
    expect(walletAssetDetails(createWalletAssetCatalog([]), "ff".repeat(32))).toEqual({ label: "Unknown asset", ticker: "base units", precision: 0 });
  });
});
