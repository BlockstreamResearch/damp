import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchCanonicalRegistryFile: vi.fn(),
  getPolicySnapshot: vi.fn(),
  putPolicySnapshot: vi.fn(),
  preparePolicy: vi.fn(),
  validatePolicySnapshot: vi.fn(),
}));

vi.mock("./github", () => ({
  canonicalRegistryContent: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`,
  fetchCanonicalRegistryFile: mocks.fetchCanonicalRegistryFile,
  registryPathForVerifierScript: vi.fn(() => Promise.resolve("policies/custom/snapshot.json")),
}));

vi.mock("./store", () => ({
  getPolicySnapshot: mocks.getPolicySnapshot,
  putPolicySnapshot: mocks.putPolicySnapshot,
}));

vi.mock("./amp-signer", () => ({
  buildBlacklist: vi.fn(),
  preparePolicy: mocks.preparePolicy,
  validatePolicySnapshot: mocks.validatePolicySnapshot,
}));

import { resolvePolicySnapshot } from "./policy-registry";
import type { Deployment, PolicySnapshot } from "./domain";

const deploymentId = "09".repeat(32);
const snapshot: PolicySnapshot = {
  schema: "simplicity-amp-registry-v1",
  protocol: "simplicity-amp/v0.1",
  deploymentId,
  sequence: 0,
  parentPolicyRoot: null,
  parentVerifierScriptHash: null,
  treeDepth: 4,
  setRoot: "10".repeat(32),
  entryCount: 0,
  policyRoot: "11".repeat(32),
  verifierProgramHash: "12".repeat(32),
  verifierScriptPubkey: "51",
  entries: [],
};

const deployment: Deployment = {
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
  deploymentId,
  confirmations: 2,
  activeAnchor: `${"13".repeat(32)}:0`,
  publication: "published",
  registryRepository: "example/custom-registry",
};

describe("policy registry source binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPolicySnapshot.mockResolvedValue(snapshot);
    mocks.preparePolicy.mockResolvedValue({
      policyRoot: snapshot.policyRoot,
      verifierProgramHash: snapshot.verifierProgramHash,
      verifierScriptPubkey: snapshot.verifierScriptPubkey,
    });
  });

  it("fails closed when the pinned custom source removed a policy even if an old cache exists", async () => {
    mocks.fetchCanonicalRegistryFile.mockResolvedValue(undefined);
    await expect(resolvePolicySnapshot(deployment, snapshot.verifierScriptPubkey)).rejects.toThrow(/not published/i);
    expect(mocks.fetchCanonicalRegistryFile).toHaveBeenCalledWith(
      "policies/custom/snapshot.json",
      fetch,
      "example/custom-registry",
    );
    expect(mocks.getPolicySnapshot).not.toHaveBeenCalled();
  });

  it("accepts and stores only canonical bytes fetched from the pinned custom source", async () => {
    mocks.fetchCanonicalRegistryFile.mockResolvedValue(`${JSON.stringify(snapshot, null, 2)}\n`);
    await expect(resolvePolicySnapshot(deployment, snapshot.verifierScriptPubkey)).resolves.toEqual(snapshot);
    expect(mocks.validatePolicySnapshot).toHaveBeenCalledWith(snapshot);
    expect(mocks.putPolicySnapshot).toHaveBeenCalledWith(snapshot, expect.any(String), "example/custom-registry");
  });
});
