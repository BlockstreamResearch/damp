import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import * as signerModule from "../generated/amp-signer/simplicity_amp_signer";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL(
    ["..", "generated", "amp-signer", "simplicity_amp_signer_bg.wasm"].join("/"),
    import.meta.url,
  ));
  await signerModule.default(await readFile(wasm));
});

describe("AMP signer WebAssembly", () => {
  it("derives stable LWK addresses and builds a D4 blacklist", () => {
    const signer = new signerModule.AmpSigner(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "elements-regtest",
    );
    const first = signer.deriveWalletAddress(0, 0) as { confidentialAddress: string; scriptPubkey: string };
    const again = signer.deriveWalletAddress(0, 0) as typeof first;
    expect(again).toEqual(first);
    expect(first.confidentialAddress.length).toBeGreaterThan(20);
    expect(first.scriptPubkey).toMatch(/^[0-9a-f]+$/);

    const built = signerModule.buildBlacklist([], 4) as { entryCount: number; treeDepth: number };
    expect(built).toMatchObject({ entryCount: 0, treeDepth: 4 });
    signer.free();
  });
});
