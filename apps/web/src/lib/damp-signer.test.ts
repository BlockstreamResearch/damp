import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import * as signerModule from "../generated/damp-signer/simplicity_damp_signer";
import deploymentFixture from "../../../../registry/fixtures/deployment.valid.json";
import policyVectors from "../../../../fixtures/policy-vectors.json";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL(
    ["..", "generated", "damp-signer", "simplicity_damp_signer_bg.wasm"].join("/"),
    import.meta.url,
  ));
  await signerModule.default(await readFile(wasm));
});

describe("DAMP signer WebAssembly", () => {
  it("matches every shared Rust policy digest vector", () => {
    for (const vector of policyVectors) {
      expect(signerModule.buildBlacklist(vector.entries, vector.treeDepth)).toEqual(vector);
    }
  });

  it("rejects invalid numeric coordinates without truncating them", () => {
    const signer = new signerModule.DampSigner(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      "elements-regtest",
    );
    try {
      for (const depth of [-1, 4.5, 260, 2 ** 32 + 4, NaN, Infinity, "4", undefined]) {
        expect(() => signerModule.buildBlacklist([], depth)).toThrow();
      }
      for (const branch of [-1, 0.5, 2, 256, "0", undefined]) {
        expect(() => signer.deriveWalletAddress(branch, 0)).toThrow();
      }
      for (const index of [-1, 0.5, 2 ** 31, 2 ** 32, "0", undefined]) {
        expect(() => signer.deriveWalletAddress(0, index)).toThrow();
      }
    } finally {
      signer.free();
    }
  });

  it("matches the canonical deployment identity after parsing", () => {
    expect(signerModule.validateDeployment(deploymentFixture)).toBe("bb176f81323fbbfadfa6a64280f9ce7fd4a4d339f63ebf0119ed0a9783109761");
  });

  it("derives stable LWK addresses and builds a D4 blacklist", () => {
    const signer = new signerModule.DampSigner(
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
