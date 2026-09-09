import { describe, expect, it, vi } from "vitest";

describe.runIf(import.meta.env.MODE === "registry-live")("published official registry", () => {
  it("discovers canonical manifests from main/registry without a shipped catalog", async () => {
    vi.stubEnv("VITE_LOCAL_REGISTRY_BASE_URL", "");
    vi.resetModules();
    try {
      const { fetchCanonicalDeploymentCatalog } = await import("./github");
      const urls: string[] = [];
      const request: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        urls.push(url.toString());
        const headers = new Headers(init?.headers);
        // CI can authenticate API reads without sending its token to raw content hosts.
        if (url.origin === "https://api.github.com" && process.env.GITHUB_TOKEN) {
          headers.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);
        }
        return fetch(input, { ...init, headers, signal: AbortSignal.timeout(20_000) });
      };
      const root = await request("https://api.github.com/repos/BlockstreamResearch/damp/contents/registry?ref=main");
      expect(root.status, "The official registry directory must exist").toBe(200);
      expect(Array.isArray(await root.json())).toBe(true);

      const catalog = await fetchCanonicalDeploymentCatalog(request);
      expect(urls).toContain("https://api.github.com/repos/BlockstreamResearch/damp/contents/registry/deployments?ref=main");
      expect(urls.every((url) => !url.endsWith("index.json"))).toBe(true);
      for (const deployment of catalog) {
        expect(urls).toContain(`https://raw.githubusercontent.com/BlockstreamResearch/damp/main/registry/deployments/${deployment.deploymentId}.json`);
      }
      console.info(`Verified ${catalog.length} published registry deployment manifests.`);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  }, 60_000);
});
