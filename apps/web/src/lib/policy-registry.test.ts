import { manifestFixture } from "../test/fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchCanonicalRegistryFile: vi.fn(),
  getPolicySnapshot: vi.fn(),
  putPolicySnapshot: vi.fn(),
  preparePolicy: vi.fn(),
  validatePolicySnapshot: vi.fn(),
}));

vi.mock("./github", async (importOriginal) => ({
  ...await importOriginal<typeof import("./github")>(),
  fetchCanonicalRegistryFile: mocks.fetchCanonicalRegistryFile,
  registryPathForVerifierScript: vi.fn(() => Promise.resolve("registry/policies/custom/snapshot.json")),
}));

vi.mock("./store", () => ({
  getPolicySnapshot: mocks.getPolicySnapshot,
  putPolicySnapshot: mocks.putPolicySnapshot,
}));

vi.mock("./damp-signer", () => ({
  buildBlacklist: vi.fn(),
  preparePolicy: mocks.preparePolicy,
  validatePolicySnapshot: mocks.validatePolicySnapshot,
}));

import { resolvePolicyHistory, resolvePolicySnapshot } from "./policy-registry";
import type { Deployment, PolicySnapshot } from "./domain";

const deploymentId = "09".repeat(32);
const snapshot: PolicySnapshot = {
  schema: "simplicity-damp-registry-v1",
  protocol: "simplicity-damp/v0.2",
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
  ...manifestFixture(),
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
      "registry/policies/custom/snapshot.json",
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

  it("loads and validates the complete predecessor chain for reporting", async () => {
    const parentHash = await crypto.subtle.digest("SHA-256", Uint8Array.from([0x51]));
    const parentScriptHash = [...new Uint8Array(parentHash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const latest: PolicySnapshot = {
      ...snapshot,
      sequence: 1,
      parentPolicyRoot: snapshot.policyRoot,
      parentVerifierScriptHash: parentScriptHash,
      policyRoot: "21".repeat(32),
      verifierProgramHash: "22".repeat(32),
      verifierScriptPubkey: "52",
    };
    mocks.fetchCanonicalRegistryFile.mockResolvedValue(`${JSON.stringify(snapshot, null, 2)}\n`);
    mocks.preparePolicy.mockResolvedValueOnce({
      policyRoot: snapshot.policyRoot,
      verifierProgramHash: snapshot.verifierProgramHash,
      verifierScriptPubkey: snapshot.verifierScriptPubkey,
    });

    await expect(resolvePolicyHistory(deployment, latest)).resolves.toEqual([snapshot, latest]);
    expect(mocks.fetchCanonicalRegistryFile).toHaveBeenCalledWith(
      `registry/policies/${deploymentId}/${parentScriptHash}.json`,
      fetch,
      "example/custom-registry",
    );
    expect(mocks.putPolicySnapshot).toHaveBeenCalledWith(snapshot, parentScriptHash, "example/custom-registry");
  });

  it("rejects a predecessor that does not match the successor policy root", async () => {
    const parentScriptHash = "aa".repeat(32);
    const latest: PolicySnapshot = {
      ...snapshot,
      sequence: 1,
      parentPolicyRoot: "ff".repeat(32),
      parentVerifierScriptHash: parentScriptHash,
      verifierScriptPubkey: "52",
    };
    mocks.fetchCanonicalRegistryFile.mockResolvedValue(`${JSON.stringify(snapshot, null, 2)}\n`);
    await expect(resolvePolicyHistory(deployment, latest)).rejects.toThrow(/successor commitment/i);
  });
});
