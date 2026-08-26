import { describe, expect, it, vi } from "vitest";

import {
  canonicalRegistryContent,
  customGitHubManifestSource,
  deploymentRegistryPath,
  fetchCanonicalDeploymentCatalog,
  localDevelopmentRegistryUrl,
  registryRepositoryUrlFor,
  verifyCanonicalRegistryFile,
} from "./github";
import type { DeploymentManifest } from "./domain";

const path = deploymentRegistryPath("ab".repeat(32));
const manifest = { schema: "amp-deployment-manifest-v1", sequence: 0 };
const catalogDeploymentId = "cd".repeat(32);
const catalogManifest: DeploymentManifest = {
  schema: "simplicity-amp-registry-v1",
  protocol: "simplicity-amp/v0.1",
  network: "liquid-testnet",
  policyAsset: "01".repeat(32),
  regulatedAsset: "02".repeat(32),
  verifierAsset: "03".repeat(32),
  verifierAssetAmount: 1,
  issuerPublicKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  deploymentSalt: "04".repeat(32),
  genesisAnchor: `${"05".repeat(32)}:0`,
  asset: { name: "Only canonical asset", ticker: "ONE", precision: 2 },
  issuedSupply: "1000",
  supplyMode: "fixed",
  reissuanceToken: null,
  reissuanceEntropy: null,
  userProgramHash: "06".repeat(32),
  governanceProgramHash: "07".repeat(32),
  contractBundleHash: "08".repeat(32),
};

function registryRequest(content?: string) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/BlockstreamResearch/damp") {
      return new Response(JSON.stringify({ default_branch: "dev" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return content === undefined
      ? new Response("not found", { status: 404 })
      : new Response(content, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("manual registry publication", () => {
  it("pins custom GitHub manifests to the repository default branch", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })) as typeof fetch;
    const id = "ab".repeat(32);
    await expect(customGitHubManifestSource(`https://github.com/example/registry/blob/main/deployments/${id}.json`, request)).resolves.toEqual({
      sourceRepository: "example/registry",
      manifestUrl: `https://raw.githubusercontent.com/example/registry/main/deployments/${id}.json`,
    });
    await expect(customGitHubManifestSource(`https://github.com/example/registry/blob/dev/deployments/${id}.json`, request)).rejects.toThrow(/default branch \(main\)/i);
    await expect(customGitHubManifestSource("https://example.com/manifest.json", request)).rejects.toThrow(/github\.com/i);
  });

  it("uses deterministic manifest paths and canonical bytes", () => {
    expect(path).toBe(`deployments/${"ab".repeat(32)}.json`);
    expect(() => deploymentRegistryPath("../manifest")).toThrow("32-byte lowercase hex");
    expect(canonicalRegistryContent(manifest)).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it("accepts the exact file from the canonical default branch", async () => {
    const request = registryRequest(canonicalRegistryContent(manifest));
    await expect(verifyCanonicalRegistryFile(path, manifest, request)).resolves.toBe(canonicalRegistryContent(manifest));
    expect(request).toHaveBeenLastCalledWith(
      `https://raw.githubusercontent.com/BlockstreamResearch/damp/dev/${path}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
  });

  it("rejects missing or byte-different files", async () => {
    await expect(verifyCanonicalRegistryFile(path, manifest, registryRequest())).rejects.toThrow("is not available");
    await expect(verifyCanonicalRegistryFile(path, manifest, registryRequest(JSON.stringify(manifest)))).rejects.toThrow("does not match");
  });

  it("allows registry overrides only for loopback development servers", () => {
    expect(localDevelopmentRegistryUrl(true, "http://127.0.0.1:5173/registry")).toBe("http://127.0.0.1:5173/registry/");
    expect(localDevelopmentRegistryUrl(true, "https://localhost:4443/registry/")).toBe("https://localhost:4443/registry/");
    expect(localDevelopmentRegistryUrl(false, "http://127.0.0.1:5173/registry")).toBeUndefined();
    expect(() => localDevelopmentRegistryUrl(true, "https://registry.example/amp")).toThrow("loopback host");
    expect(() => localDevelopmentRegistryUrl(true, "file:///tmp/registry")).toThrow("loopback host");
  });

  it("builds repository links for validated custom registry identifiers", () => {
    expect(registryRepositoryUrlFor("example/custom-registry")).toBe("https://github.com/example/custom-registry");
    expect(() => registryRepositoryUrlFor("https://github.com/example/custom-registry")).toThrow(/owner\/repository/i);
  });

  it("enumerates only canonical deployment manifests from the default branch", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/BlockstreamResearch/damp") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (url === "https://api.github.com/repos/BlockstreamResearch/damp/contents/deployments?ref=main") {
        return new Response(JSON.stringify([
          { name: `${catalogDeploymentId}.json`, type: "file" },
          { name: "README.md", type: "file" },
        ]), { status: 200 });
      }
      if (url === `https://raw.githubusercontent.com/BlockstreamResearch/damp/main/deployments/${catalogDeploymentId}.json`) {
        return new Response(canonicalRegistryContent(catalogManifest), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(fetchCanonicalDeploymentCatalog(request)).resolves.toEqual([
      { deploymentId: catalogDeploymentId, manifest: catalogManifest },
    ]);
  });

  it("treats a missing deployments directory as an authoritative empty catalog", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/BlockstreamResearch/damp") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (url === "https://api.github.com/repos/BlockstreamResearch/damp/contents/deployments?ref=main") {
        return new Response("not found", { status: 404 });
      }
      return new Response("unexpected request", { status: 500 });
    }) as typeof fetch;

    await expect(fetchCanonicalDeploymentCatalog(request)).resolves.toEqual([]);
  });

  it("rejects a catalog manifest that is not encoded as exact canonical bytes", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/BlockstreamResearch/damp") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (url.includes("/contents/deployments?")) {
        return new Response(JSON.stringify([{ name: `${catalogDeploymentId}.json`, type: "file" }]), { status: 200 });
      }
      return new Response(JSON.stringify(catalogManifest), { status: 200 });
    }) as typeof fetch;
    await expect(fetchCanonicalDeploymentCatalog(request)).rejects.toThrow("canonical bytes");
  });
});
