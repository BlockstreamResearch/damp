import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signer: { connected: false, network: "liquid-testnet" as "liquid-testnet" | "elements-regtest", fingerprint: undefined as string | undefined, profileId: undefined as string | undefined },
  deriveIssuer: vi.fn(),
  putDeployment: vi.fn(),
  getDeployment: vi.fn(),
  putPolicySnapshot: vi.fn(),
  setActiveDeploymentId: vi.fn(),
}));

vi.mock("./amp-signer", () => ({
  deriveAmpKey: mocks.deriveIssuer,
  signerSnapshot: () => mocks.signer,
  signerSessionRevision: () => 1,
  validateDeployment: vi.fn(),
}));

vi.mock("./store", () => ({
  getDeployment: mocks.getDeployment,
  putDeployment: mocks.putDeployment,
  putPolicySnapshot: mocks.putPolicySnapshot,
  setActiveDeploymentId: mocks.setActiveDeploymentId,
}));

vi.mock("./policy-registry", () => ({
  resolvePolicySnapshot: vi.fn(),
  sha256Hex: vi.fn(() => Promise.resolve("aa".repeat(32))),
}));

vi.mock("./github", () => ({
  deploymentRegistryPath: (deploymentId: string) => `deployments/${deploymentId}.json`,
  verifyCanonicalRegistryFile: vi.fn(),
}));

vi.mock("./esplora", () => ({
  esploraUrlForDeployment: () => "http://127.0.0.1:3001",
  traverseLiveAnchor: vi.fn(),
}));

import {
  attachIssuerControl,
  persistPublicDeploymentImport,
  publicImportHasIssuerAuthority,
  validatePublicDeploymentImport,
} from "./deployment-import";
import type { Deployment, DeploymentManifest, PolicySnapshot } from "./domain";

const deploymentId = "09".repeat(32);
const manifest: DeploymentManifest = {
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
};

const snapshot = {
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
} satisfies PolicySnapshot;

function importedDeployment(): Deployment {
  return {
    ...manifest,
    deploymentId,
    confirmations: 2,
    activeAnchor: `${"13".repeat(32)}:0`,
    publication: "published",
  };
}

describe("role-neutral deployment import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signer.connected = false;
    mocks.signer.network = "liquid-testnet";
    mocks.getDeployment.mockResolvedValue(undefined);
  });

  it("requires exact canonical manifest verification and creates no issuer authority", async () => {
    const verifyCanonicalManifest = vi.fn(() => Promise.resolve("canonical"));
    const result = await validatePublicDeploymentImport(JSON.stringify(manifest), {
      validateDeployment: vi.fn(() => Promise.resolve(deploymentId)),
      verifyCanonicalManifest,
      traverseAnchor: vi.fn(() => Promise.resolve({
        genesis: manifest.genesisAnchor,
        live: { txid: "13".repeat(32), vout: 0 as const, scriptPubkey: "51", confirmations: 2 },
        path: [manifest.genesisAnchor],
        tipHeight: 100,
      })),
      resolvePolicy: vi.fn(() => Promise.resolve(snapshot)),
    });

    expect(verifyCanonicalManifest).toHaveBeenCalledWith(`deployments/${deploymentId}.json`, manifest);
    expect(result.deployment.publication).toBe("published");
    expect(result.deployment.issuerDerivationIndex).toBeUndefined();
    expect(publicImportHasIssuerAuthority(result.deployment)).toBe(false);
  });

  it("fails before persistence when canonical bytes do not match", async () => {
    await expect(validatePublicDeploymentImport(JSON.stringify(manifest), {
      validateDeployment: vi.fn(() => Promise.resolve(deploymentId)),
      verifyCanonicalManifest: vi.fn(() => Promise.reject(new Error("canonical mismatch"))),
    })).rejects.toThrow("canonical mismatch");
    expect(mocks.putDeployment).not.toHaveBeenCalled();
  });

  it("strips injected authority while preserving an authority already attached locally", async () => {
    const injected = { ...importedDeployment(), issuerDerivationIndex: 999, issuerFingerprint: "11223344" };
    await persistPublicDeploymentImport({ deployment: injected, snapshot });
    expect(mocks.putDeployment).toHaveBeenLastCalledWith(expect.objectContaining({ issuerDerivationIndex: undefined, issuerFingerprint: undefined }));

    const issuerProfileId = `elements-regtest:${"aa".repeat(32)}`;
    mocks.getDeployment.mockResolvedValue({ ...importedDeployment(), issuerDerivationIndex: 7, issuerFingerprint: "aabbccdd", issuerProfileId });
    await persistPublicDeploymentImport({ deployment: injected, snapshot });
    expect(mocks.putDeployment).toHaveBeenLastCalledWith(expect.objectContaining({ issuerDerivationIndex: 7, issuerFingerprint: "aabbccdd", issuerProfileId }));
  });

  it("keeps issuer attachment network- and key-gated", async () => {
    mocks.signer.connected = true;
    mocks.signer.fingerprint = "aabbccdd";
    mocks.signer.profileId = `elements-regtest:${"aa".repeat(32)}`;
    mocks.signer.network = "liquid-testnet";
    await expect(attachIssuerControl(importedDeployment())).rejects.toThrow("Reconnect the DAMP signer for elements-regtest");
    expect(mocks.deriveIssuer).not.toHaveBeenCalled();

    mocks.signer.network = "elements-regtest";
    mocks.deriveIssuer.mockResolvedValue({ publicKey: manifest.issuerPublicKey, derivationIndex: 42 });
    const attached = await attachIssuerControl(importedDeployment());
    expect(mocks.deriveIssuer).toHaveBeenCalledWith(manifest.deploymentSalt, "issuer", "elements-regtest");
    expect(attached.issuerDerivationIndex).toBe(42);
    expect(attached.issuerFingerprint).toBe("aabbccdd");
    expect(attached.issuerProfileId).toBe(mocks.signer.profileId);
    expect(mocks.putDeployment).toHaveBeenCalledWith(attached);
  });
});
