import { describe, expect, it } from "vitest";

import {
  blacklistEntrySchema,
  deploymentManifestSchema,
  parseUnits,
  smallestTreeDepth,
  userFacingError,
} from "./domain";

const hash = "11".repeat(32);
const xonly = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const manifest = {
  schema: "simplicity-amp-registry-v1",
  protocol: "simplicity-amp/v0.1",
  network: "liquid-testnet",
  policyAsset: "01".repeat(32),
  regulatedAsset: "02".repeat(32),
  verifierAsset: "03".repeat(32),
  verifierAssetAmount: 1,
  issuerPublicKey: xonly,
  deploymentSalt: "04".repeat(32),
  genesisAnchor: `${"05".repeat(32)}:0`,
  asset: { name: "Regulated", ticker: "RGA", precision: 8 },
  issuedSupply: "100000000",
  supplyMode: "fixed",
  reissuanceToken: null,
  reissuanceEntropy: null,
  userProgramHash: "06".repeat(32),
  governanceProgramHash: "07".repeat(32),
  contractBundleHash: "08".repeat(32),
} as const;

describe("registry schemas", () => {
  it("rejects mainnet and unknown manifest fields", () => {
    expect(() => deploymentManifestSchema.parse({ ...manifest, network: "liquid-mainnet" })).toThrow();
    expect(() => deploymentManifestSchema.parse({ ...manifest, verifierProgramHash: hash })).toThrow();
  });

  it("requires reissuance fields exactly for managed supply", () => {
    expect(() => deploymentManifestSchema.parse({ ...manifest, supplyMode: "issuer-managed" })).toThrow();
  });

  it("requires policy, regulated, and verifier assets to be distinct", () => {
    expect(() => deploymentManifestSchema.parse({
      ...manifest,
      verifierAsset: manifest.regulatedAsset,
    })).toThrow(/distinct/);
  });

  it("keeps bans scoped to one exact output", () => {
    const first = blacklistEntrySchema.parse({ txid: hash, vout: 0 });
    const sibling = blacklistEntrySchema.parse({ txid: first.txid, vout: 1 });
    expect(sibling).not.toEqual(first);
  });

  it("uses iterative capacities and rejects overflow", () => {
    expect(smallestTreeDepth(16)).toBe(4);
    expect(smallestTreeDepth(17)).toBe(5);
    expect(smallestTreeDepth(33)).toBe(6);
    expect(() => smallestTreeDepth(65)).toThrow();
  });

  it("parses decimal units without unsafe number conversion", () => {
    expect(parseUnits("1.25", 8)).toBe(125_000_000n);
    expect(() => parseUnits("1.000000001", 8)).toThrow();
  });

  it("turns strict schema failures into concise field-specific feedback", () => {
    const parsed = deploymentManifestSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const message = userFacingError(parsed.error);
      expect(message).toMatch(/^Invalid data at schema:/);
      expect(message).toMatch(/more validation errors\.$/);
      expect(message).not.toContain('"code"');
    }
  });
});
