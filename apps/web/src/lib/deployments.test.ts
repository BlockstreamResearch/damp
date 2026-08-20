import { describe, expect, it } from "vitest";

import { localDeploymentSchema, requirePublishedDeployment } from "./domain";

const base = {
  schema: "simplicity-amp-registry-v1",
  protocol: "simplicity-amp/v0.1",
  network: "elements-regtest",
  policyAsset: "01".repeat(32),
  regulatedAsset: "02".repeat(32),
  verifierAsset: "03".repeat(32),
  verifierAssetAmount: 1,
  issuerPublicKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  deploymentSalt: "04".repeat(32),
  genesisAnchor: `${"05".repeat(32)}:0`,
  asset: { name: "Regulated", ticker: "RGA", precision: 8 },
  issuedSupply: "100",
  supplyMode: "fixed",
  reissuanceToken: null,
  reissuanceEntropy: null,
  userProgramHash: "06".repeat(32),
  governanceProgramHash: "07".repeat(32),
  contractBundleHash: "08".repeat(32),
  deploymentId: "09".repeat(32),
  confirmations: 1,
  activeAnchor: `${"05".repeat(32)}:0`,
} as const;

describe("deployment operation gating", () => {
  it("allows only canonical-published deployments", () => {
    const published = localDeploymentSchema.parse({ ...base, publication: "published" });
    expect(requirePublishedDeployment(published)).toBe(published);

    const pending = localDeploymentSchema.parse({ ...base, publication: "pending" });
    expect(() => requirePublishedDeployment(pending)).toThrow(/must be published/);
  });
});
