import { beforeEach, describe, expect, it } from "vitest";

import { liquidTestnetFaucetUrl, liquidTestnetPolicyAsset, nativeFeeAssetId } from "./faucet";

describe("test funding", () => {
  beforeEach(() => localStorage.clear());

  it("uses the Liquid testnet native fee asset", () => {
    expect(nativeFeeAssetId("liquid-testnet")).toBe(liquidTestnetPolicyAsset);
  });

  it("builds an encoded L-BTC faucet request", () => {
    const address = `tlq1${"q".repeat(70)}`;
    const url = new URL(liquidTestnetFaucetUrl(address));
    expect(url.origin).toBe("https://liquidtestnet.com");
    expect(url.pathname).toBe("/faucet");
    expect(url.searchParams.get("address")).toBe(address);
    expect(url.searchParams.get("action")).toBe("lbtc");
  });

  it("supports an explicitly configured regtest native asset", () => {
    localStorage.setItem("simplicity-amp:regtest-policy-asset:v1", "ab".repeat(32));
    expect(nativeFeeAssetId("elements-regtest")).toBe("ab".repeat(32));
  });
});
