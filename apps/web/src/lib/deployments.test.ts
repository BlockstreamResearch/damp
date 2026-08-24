import { describe, expect, it, vi } from "vitest";

vi.mock("./amp-signer", () => ({ validateDeployment: vi.fn() }));
vi.mock("./store", () => ({
  getActiveDeploymentId: vi.fn(),
  listDeployments: vi.fn(),
  setActiveDeploymentId: vi.fn(),
}));

import { localDeploymentSchema, publicManifest, requirePublishedDeployment } from "./domain";
import { loadDeploymentState } from "./deployments";

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

  it("filters stale published cache entries against the canonical asset catalog", async () => {
    const canonical = localDeploymentSchema.parse({ ...base, publication: "published" });
    const stale = localDeploymentSchema.parse({
      ...base,
      deploymentId: "0a".repeat(32),
      asset: { ...base.asset, name: "Stale cached asset", ticker: "OLD" },
      publication: "published",
    });
    const select = vi.fn(() => Promise.resolve());
    const state = await loadDeploymentState({
      catalog: () => Promise.resolve([{ deploymentId: canonical.deploymentId, manifest: publicManifest(canonical) }]),
      local: () => Promise.resolve([stale, canonical]),
      activeId: () => Promise.resolve(stale.deploymentId),
      select,
      validate: () => Promise.resolve(canonical.deploymentId),
    });

    expect(state.deployments.map((deployment) => deployment.asset.ticker)).toEqual(["RGA"]);
    expect(state.activeId).toBe(canonical.deploymentId);
    expect(select).toHaveBeenCalledWith(canonical.deploymentId);
  });

  it("exposes no published assets when the canonical registry is empty", async () => {
    const stale = localDeploymentSchema.parse({ ...base, publication: "published" });
    const select = vi.fn(() => Promise.resolve());
    const state = await loadDeploymentState({
      catalog: () => Promise.resolve([]),
      local: () => Promise.resolve([stale]),
      activeId: () => Promise.resolve(stale.deploymentId),
      select,
      validate: vi.fn(),
    });

    expect(state).toEqual({ deployments: [], activeId: null, active: null });
    expect(select).not.toHaveBeenCalled();
  });

  it("retains unpublished issuer work without treating stale published records as supported", async () => {
    const canonical = localDeploymentSchema.parse({ ...base, publication: "published" });
    const pending = localDeploymentSchema.parse({
      ...base,
      deploymentId: "0b".repeat(32),
      asset: { ...base.asset, name: "Pending issuer asset", ticker: "NEW" },
      publication: "pending",
    });
    const state = await loadDeploymentState({
      catalog: () => Promise.resolve([{ deploymentId: canonical.deploymentId, manifest: publicManifest(canonical) }]),
      local: () => Promise.resolve([canonical, pending]),
      activeId: () => Promise.resolve(canonical.deploymentId),
      select: vi.fn(() => Promise.resolve()),
      validate: () => Promise.resolve(canonical.deploymentId),
    });
    expect(state.deployments.map((deployment) => deployment.asset.ticker)).toEqual(["RGA", "NEW"]);
  });

  it("rejects a canonical filename that does not match the manifest deployment ID", async () => {
    const canonical = localDeploymentSchema.parse({ ...base, publication: "published" });
    await expect(loadDeploymentState({
      catalog: () => Promise.resolve([{ deploymentId: canonical.deploymentId, manifest: publicManifest(canonical) }]),
      local: () => Promise.resolve([canonical]),
      activeId: () => Promise.resolve(canonical.deploymentId),
      select: vi.fn(() => Promise.resolve()),
      validate: () => Promise.resolve("ff".repeat(32)),
    })).rejects.toThrow("filename does not match");
  });
});
