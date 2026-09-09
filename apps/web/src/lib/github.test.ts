import { manifestFixture } from "../test/fixtures";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalRegistryContent,
  customGitHubManifestSource,
  deploymentRegistryPath,
  fetchCanonicalDeploymentCatalog,
  fetchCanonicalRegistryFile,
  localDevelopmentRegistryUrl,
  registryRepositoryUrlFor,
  registryPathForVerifierScriptHash,
  verifyCanonicalRegistryFile,
} from "./github";
import type { DeploymentManifest } from "./domain";

const path = deploymentRegistryPath("ab".repeat(32));
const manifest = { schema: "damp-deployment-manifest-v1", sequence: 0 };
const catalogDeploymentId = "cd".repeat(32);
const catalogManifest: DeploymentManifest = {
  ...manifestFixture(),
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
    return content === undefined
      ? new Response("not found", { status: 404 })
      : new Response(content, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("manual registry publication", () => {
  it("pins custom GitHub manifests to the repository default branch", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ default_branch: "main" }), { status: 200 })) as typeof fetch;
    const id = "ab".repeat(32);
    await expect(customGitHubManifestSource(`https://github.com/example/registry/blob/main/registry/deployments/${id}.json`, request)).resolves.toEqual({
      sourceRepository: "example/registry",
      manifestUrl: `https://raw.githubusercontent.com/example/registry/main/registry/deployments/${id}.json`,
    });
    await expect(customGitHubManifestSource(`https://github.com/example/registry/blob/dev/registry/deployments/${id}.json`, request)).rejects.toThrow(/default branch \(main\)/i);
    await expect(customGitHubManifestSource(`https://github.com/example/registry/blob/main/deployments/${id}.json`, request)).rejects.toThrow("registry/deployments/");
    await expect(customGitHubManifestSource("https://example.com/manifest.json", request)).rejects.toThrow(/github\.com/i);
  });

  it("uses deterministic manifest paths and canonical bytes", () => {
    expect(path).toBe(`registry/deployments/${"ab".repeat(32)}.json`);
    expect(registryPathForVerifierScriptHash("ab".repeat(32), "cd".repeat(32))).toBe(`registry/policies/${"ab".repeat(32)}/${"cd".repeat(32)}.json`);
    expect(() => registryPathForVerifierScriptHash("../invalid", "cd".repeat(32))).toThrow("Invalid canonical registry path");
    expect(() => deploymentRegistryPath("../manifest")).toThrow("32-byte lowercase hex");
    expect(canonicalRegistryContent(manifest)).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it("accepts the exact file from the canonical default branch", async () => {
    const request = registryRequest(canonicalRegistryContent(manifest));
    await expect(verifyCanonicalRegistryFile(path, manifest, request)).resolves.toBe(canonicalRegistryContent(manifest));
    expect(request).toHaveBeenLastCalledWith(
      `https://raw.githubusercontent.com/BlockstreamResearch/damp/main/${path}`,
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
    expect(() => localDevelopmentRegistryUrl(true, "https://registry.example/damp")).toThrow("loopback host");
    expect(() => localDevelopmentRegistryUrl(true, "file:///tmp/registry")).toThrow("loopback host");
  });

  it("rejects obsolete root-level paths before fetching", async () => {
    const request = vi.fn() as typeof fetch;
    await expect(fetchCanonicalRegistryFile(`deployments/${"ab".repeat(32)}.json`, request)).rejects.toThrow("Invalid canonical registry path");
    await expect(fetchCanonicalRegistryFile(`policies/${"ab".repeat(32)}/${"cd".repeat(32)}.json`, request)).rejects.toThrow("Invalid canonical registry path");
    expect(request).not.toHaveBeenCalled();
  });

  it("builds repository links for validated custom registry identifiers", () => {
    expect(registryRepositoryUrlFor()).toBe("https://github.com/BlockstreamResearch/damp/tree/main/registry");
    expect(registryRepositoryUrlFor("example/custom-registry")).toBe("https://github.com/example/custom-registry");
    expect(() => registryRepositoryUrlFor("https://github.com/example/custom-registry")).toThrow(/owner\/repository/i);
  });

  it("discovers official manifests from the live registry directory without a bundled index", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/BlockstreamResearch/damp/contents/registry/deployments?ref=main") {
        return Response.json([
          { name: `${catalogDeploymentId}.json`, type: "file" },
          { name: "README.md", type: "file" },
          { name: `${"ef".repeat(32)}.json`, type: "dir" },
        ]);
      }
      if (url === `https://raw.githubusercontent.com/BlockstreamResearch/damp/main/registry/deployments/${catalogDeploymentId}.json`) {
        return new Response(canonicalRegistryContent(catalogManifest), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(fetchCanonicalDeploymentCatalog(request)).resolves.toEqual([
      { deploymentId: catalogDeploymentId, manifest: catalogManifest },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1,
      "https://api.github.com/repos/BlockstreamResearch/damp/contents/registry/deployments?ref=main",
      { cache: "no-store", headers: { Accept: "application/vnd.github+json" } },
    );
    expect(request).not.toHaveBeenCalledWith(expect.stringContaining("index.json"), expect.anything());
  });

  it("accepts an empty registry directory", async () => {
    const request = vi.fn(async () => new Response("[]", { status: 200 })) as typeof fetch;
    await expect(fetchCanonicalDeploymentCatalog(request)).resolves.toEqual([]);
  });

  it("rejects a catalog manifest that is not encoded as exact canonical bytes", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com")) return Response.json([{ name: `${catalogDeploymentId}.json`, type: "file" }]);
      return new Response(JSON.stringify(catalogManifest), { status: 200 });
    }) as typeof fetch;
    await expect(fetchCanonicalDeploymentCatalog(request)).rejects.toThrow("canonical bytes");
  });

  it("explains GitHub API rate limits for custom registries", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const request = vi.fn(async () => new Response("rate limited", { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) } })) as typeof fetch;
    await expect(customGitHubManifestSource(`https://github.com/example/registry/blob/main/registry/deployments/${"ab".repeat(32)}.json`, request)).rejects.toThrow(/public API rate limit.*try again/i);
    await expect(fetchCanonicalDeploymentCatalog(request)).rejects.toThrow(/public API rate limit.*try again/i);
  });

  it("uses the registry directory on a custom repository's default branch", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/example/custom") return Response.json({ default_branch: "release/current" });
      if (url === "https://api.github.com/repos/example/custom/contents/registry/deployments?ref=release%2Fcurrent") {
        return Response.json([{ name: `${catalogDeploymentId}.json`, type: "file" }]);
      }
      if (url === `https://raw.githubusercontent.com/example/custom/release/current/registry/deployments/${catalogDeploymentId}.json`) {
        return new Response(canonicalRegistryContent(catalogManifest));
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    await expect(fetchCanonicalDeploymentCatalog(request, "example/custom")).resolves.toEqual([{ deploymentId: catalogDeploymentId, manifest: catalogManifest }]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("drops removed deployments when the directory is refreshed", async () => {
    let present = true;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("api.github.com")) return Response.json(present ? [{ name: `${catalogDeploymentId}.json`, type: "file" }] : []);
      return new Response(canonicalRegistryContent(catalogManifest));
    }) as typeof fetch;
    expect(await fetchCanonicalDeploymentCatalog(request)).toHaveLength(1);
    present = false;
    expect(await fetchCanonicalDeploymentCatalog(request)).toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("reports a listed manifest that disappears without hiding the registry failure", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => String(input).includes("api.github.com")
      ? Response.json([{ name: `${catalogDeploymentId}.json`, type: "file" }])
      : new Response("not found", { status: 404 })) as typeof fetch;
    await expect(fetchCanonicalDeploymentCatalog(request)).rejects.toThrow(`missing at registry/deployments/${catalogDeploymentId}.json`);
  });

  it("treats a missing empty directory as empty but reports provider failures", async () => {
    await expect(fetchCanonicalDeploymentCatalog(vi.fn(async () => new Response("not found", { status: 404 })) as typeof fetch)).resolves.toEqual([]);
    for (const status of [403, 500]) {
      await expect(fetchCanonicalDeploymentCatalog(vi.fn(async () => new Response("failed", { status })) as typeof fetch)).rejects.toThrow(/GitHub/);
    }
  });

  it("rejects malformed, duplicate and oversized catalogs", async () => {
    const entry = { name: `${catalogDeploymentId}.json`, type: "file" };
    for (const body of [{}, [null], [entry, entry], Array.from({ length: 129 }, () => entry)]) {
      await expect(fetchCanonicalDeploymentCatalog(vi.fn(async () => Response.json(body)) as typeof fetch)).rejects.toThrow();
    }
    const request = vi.fn(async () => new Response("[]", { headers: { "content-length": String(1024 * 1024 + 1) } })) as typeof fetch;
    await expect(fetchCanonicalDeploymentCatalog(request)).rejects.toThrow("exceeds its size limit");
  });

  it("keeps loopback override paths relative to the registry directory", async () => {
    vi.stubEnv("VITE_LOCAL_REGISTRY_BASE_URL", "http://127.0.0.1:4174/registry/");
    vi.resetModules();
    try {
      const local = await import("./github");
      const request = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://127.0.0.1:4174/registry/deployments/index.json") return Response.json([catalogDeploymentId]);
        if (url === `http://127.0.0.1:4174/registry/deployments/${catalogDeploymentId}.json`) return new Response(canonicalRegistryContent(catalogManifest));
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
      await expect(local.fetchCanonicalDeploymentCatalog(request)).resolves.toEqual([{ deploymentId: catalogDeploymentId, manifest: catalogManifest }]);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
