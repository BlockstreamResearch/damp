const registryRepository = (import.meta.env.VITE_GITHUB_REGISTRY_REPO as string | undefined) ?? "BlockstreamResearch/damp";
const localRegistryBaseUrl = localDevelopmentRegistryUrl(
  import.meta.env.DEV,
  import.meta.env.VITE_LOCAL_REGISTRY_BASE_URL as string | undefined,
);

export const registryRepositoryUrl = localRegistryBaseUrl ?? `https://github.com/${registryRepository}`;

export function localDevelopmentRegistryUrl(development: boolean, configured: string | undefined) {
  if (!development || !configured) return undefined;
  const url = new URL(configured);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The development registry override must use a loopback host.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The development registry override must use HTTP or HTTPS.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
  return url.toString();
}

function assertRegistryPath(path: string) {
  if (!/^(?:deployments\/[0-9a-f]{64}\.json|policies\/[0-9a-f]{64}\/[0-9a-f]{64}\.json)$/.test(path)) {
    throw new Error("Invalid canonical registry path.");
  }
}

export function canonicalRegistryContent(content: unknown) {
  return `${JSON.stringify(content, null, 2)}\n`;
}

export function deploymentRegistryPath(deploymentId: string) {
  if (!/^[0-9a-f]{64}$/.test(deploymentId)) throw new Error("Deployment ID must be 32-byte lowercase hex.");
  return `deployments/${deploymentId}.json`;
}

export async function registryPathForVerifierScript(deploymentId: string, scriptPubkey: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(scriptPubkey)) throw new Error("Verifier script must be lowercase hex.");
  const bytes = Uint8Array.from(scriptPubkey.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const scriptHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `policies/${deploymentId}/${scriptHash}.json`;
}

export async function fetchCanonicalRegistryFile(path: string, request: typeof fetch = fetch) {
  assertRegistryPath(path);
  if (localRegistryBaseUrl) {
    const response = await request(new URL(path, localRegistryBaseUrl), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Local test registry fetch failed (${response.status}).`);
    return response.text();
  }
  const [owner, repository] = registryRepository.split("/");
  const repositoryResponse = await request(`https://api.github.com/repos/${owner}/${repository}`, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!repositoryResponse.ok) throw new Error(`Could not resolve canonical registry (${repositoryResponse.status}).`);
  const repositoryData = await repositoryResponse.json() as { default_branch: string };
  const raw = await request(
    `https://raw.githubusercontent.com/${owner}/${repository}/${repositoryData.default_branch}/${path}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (raw.status === 404) return undefined;
  if (!raw.ok) throw new Error(`Canonical registry fetch failed (${raw.status}).`);
  return raw.text();
}

export async function verifyCanonicalRegistryFile(
  path: string,
  content: unknown,
  request: typeof fetch = fetch,
) {
  const published = await fetchCanonicalRegistryFile(path, request);
  if (published === undefined) throw new Error(`Registry file is not available at ${path}.`);
  if (published !== canonicalRegistryContent(content)) {
    throw new Error(`Registry file at ${path} does not match the downloaded canonical bytes.`);
  }
  return published;
}

export function downloadCanonicalRegistryFile(path: string, content: unknown) {
  const filename = path.split("/").at(-1);
  if (!filename) throw new Error("Invalid registry path.");
  const url = URL.createObjectURL(new Blob([canonicalRegistryContent(content)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return { filename, path };
}

export async function copyCanonicalRegistryFile(path: string, content: unknown) {
  assertRegistryPath(path);
  await navigator.clipboard.writeText(canonicalRegistryContent(content));
  return { path };
}
