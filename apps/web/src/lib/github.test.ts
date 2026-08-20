import { describe, expect, it, vi } from "vitest";

import {
  canonicalRegistryContent,
  deploymentRegistryPath,
  verifyCanonicalRegistryFile,
} from "./github";

const path = deploymentRegistryPath("ab".repeat(32));
const manifest = { schema: "amp-deployment-manifest-v1", sequence: 0 };

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
});
