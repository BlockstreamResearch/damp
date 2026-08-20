import type { SignerNetwork } from "./amp-signer";

export const liquidTestnetPolicyAsset =
  "144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49";

const assetIdPattern = /^[0-9a-f]{64}$/;
const regtestPolicyAssetKey = "simplicity-amp:regtest-policy-asset:v1";

export function nativeFeeAssetId(network: SignerNetwork) {
  if (network === "liquid-testnet") return liquidTestnetPolicyAsset;

  const configured =
    (import.meta.env.VITE_ELEMENTS_REGTEST_POLICY_ASSET as string | undefined)?.trim() ||
    readLocalStorage(regtestPolicyAssetKey);
  if (!configured || !assetIdPattern.test(configured)) {
    throw new Error(
      `Configure the Elements regtest native asset as VITE_ELEMENTS_REGTEST_POLICY_ASSET or localStorage["${regtestPolicyAssetKey}"].`,
    );
  }
  return configured;
}

export function liquidTestnetFaucetUrl(confidentialAddress: string) {
  const address = confidentialAddress.trim();
  if (address.length < 20 || /\s/.test(address)) throw new Error("Invalid Liquid testnet funding address.");
  const url = new URL("https://liquidtestnet.com/faucet");
  url.searchParams.set("address", address);
  url.searchParams.set("action", "lbtc");
  return url.toString();
}

function readLocalStorage(key: string) {
  try {
    return localStorage.getItem(key)?.trim();
  } catch {
    return undefined;
  }
}
