import { deploymentManifestSchema, HASH, type DeploymentManifest } from "./domain";

const configuredRegistryRepository = (import.meta.env.VITE_GITHUB_REGISTRY_REPO as string | undefined) ?? "BlockstreamResearch/damp";
const localRegistryBaseUrl = localDevelopmentRegistryUrl(
  import.meta.env.DEV,
  import.meta.env.VITE_LOCAL_REGISTRY_BASE_URL as string | undefined,
);

export function registryRepositoryUrlFor(sourceRepository = configuredRegistryRepository) {
  if (localRegistryBaseUrl && sourceRepository === configuredRegistryRepository) return localRegistryBaseUrl;
  const { owner, repository } = repositoryParts(sourceRepository);
  return `https://github.com/${owner}/${repository}`;
}

export const registryRepositoryUrl = registryRepositoryUrlFor();

const MAX_REPOSITORY_RESPONSE_BYTES = 64 * 1024;
const MAX_CATALOG_RESPONSE_BYTES = 1024 * 1024;
const MAX_MANIFEST_RESPONSE_BYTES = 256 * 1024;
const MAX_CANONICAL_DEPLOYMENTS = 128;

export type CanonicalDeployment = {
  deploymentId: string;
  manifest: DeploymentManifest;
};

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

function repositoryParts(repository = configuredRegistryRepository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error("VITE_GITHUB_REGISTRY_REPO must be an owner/repository pair.");
  return { owner: match[1], repository: match[2] };
}

async function boundedResponseText(response: Response, maximum: number, label: string) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} exceeds its size limit.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error(`${label} exceeds its size limit.`);
  return new TextDecoder().decode(bytes);
}

async function resolveCanonicalRepository(request: typeof fetch, sourceRepository = configuredRegistryRepository) {
  const { owner, repository } = repositoryParts(sourceRepository);
  const response = await request(`https://api.github.com/repos/${owner}/${repository}`, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`Could not resolve canonical registry (${response.status}).`);
  const raw = JSON.parse(await boundedResponseText(response, MAX_REPOSITORY_RESPONSE_BYTES, "Registry metadata")) as unknown;
  if (!raw || typeof raw !== "object" || !("default_branch" in raw) || typeof raw.default_branch !== "string") {
    throw new Error("Canonical registry metadata has no default branch.");
  }
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(raw.default_branch) || raw.default_branch.includes("..")) {
    throw new Error("Canonical registry returned an invalid default branch.");
  }
  return { owner, repository, defaultBranch: raw.default_branch };
}

function parseCanonicalManifest(deploymentId: string, text: string) {
  const manifest = deploymentManifestSchema.parse(JSON.parse(text));
  if (canonicalRegistryContent(manifest) !== text) {
    throw new Error(`Registry manifest ${deploymentId} is not encoded as canonical bytes.`);
  }
  return manifest;
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

export async function fetchCanonicalRegistryFile(path: string, request: typeof fetch = fetch, sourceRepository = configuredRegistryRepository) {
  assertRegistryPath(path);
  if (localRegistryBaseUrl && sourceRepository === configuredRegistryRepository) {
    const response = await request(new URL(path, localRegistryBaseUrl), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Local test registry fetch failed (${response.status}).`);
    return boundedResponseText(response, MAX_MANIFEST_RESPONSE_BYTES, "Local registry file");
  }
  const { owner, repository, defaultBranch } = await resolveCanonicalRepository(request, sourceRepository);
  const raw = await request(
    `https://raw.githubusercontent.com/${owner}/${repository}/${defaultBranch}/${path}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (raw.status === 404) return undefined;
  if (!raw.ok) throw new Error(`Canonical registry fetch failed (${raw.status}).`);
  return boundedResponseText(raw, MAX_MANIFEST_RESPONSE_BYTES, "Canonical registry file");
}

/** Enumerate and strictly validate the manifests on the configured registry's default branch. */
export async function fetchCanonicalDeploymentCatalog(request: typeof fetch = fetch, sourceRepository = configuredRegistryRepository): Promise<CanonicalDeployment[]> {
  if (localRegistryBaseUrl && sourceRepository === configuredRegistryRepository) {
    const response = await request(new URL("deployments/index.json", localRegistryBaseUrl), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Local registry deployment index failed (${response.status}).`);
    const raw = JSON.parse(await boundedResponseText(response, MAX_CATALOG_RESPONSE_BYTES, "Local registry deployment index")) as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_CANONICAL_DEPLOYMENTS || raw.some((id) => typeof id !== "string" || !HASH.test(id))) {
      throw new Error("Local registry deployment index must contain at most 128 deployment IDs.");
    }
    const uniqueIds = [...new Set(raw)].sort();
    if (uniqueIds.length !== raw.length) throw new Error("Local registry deployment index contains duplicate IDs.");
    const catalog: CanonicalDeployment[] = [];
    for (const deploymentId of uniqueIds) {
      const text = await fetchCanonicalRegistryFile(deploymentRegistryPath(deploymentId), request, sourceRepository);
      if (text === undefined) throw new Error(`Indexed registry manifest ${deploymentId} is missing.`);
      catalog.push({ deploymentId, manifest: parseCanonicalManifest(deploymentId, text) });
    }
    return catalog;
  }

  const { owner, repository, defaultBranch } = await resolveCanonicalRepository(request, sourceRepository);
  const directory = await request(
    `https://api.github.com/repos/${owner}/${repository}/contents/deployments?ref=${encodeURIComponent(defaultBranch)}`,
    { cache: "no-store", headers: { Accept: "application/vnd.github+json" } },
  );
  // Git does not retain empty directories. A missing deployments directory is
  // therefore the canonical representation of an empty registry, not a
  // provider outage. Every other failure remains fail-closed.
  if (directory.status === 404) return [];
  if (!directory.ok) throw new Error(`Could not list canonical deployments (${directory.status}).`);
  const rawEntries = JSON.parse(await boundedResponseText(directory, MAX_CATALOG_RESPONSE_BYTES, "Registry deployment catalog")) as unknown;
  if (!Array.isArray(rawEntries) || rawEntries.length > MAX_CANONICAL_DEPLOYMENTS) {
    throw new Error("Canonical registry contains too many deployment entries.");
  }
  const deploymentIds = rawEntries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Canonical deployment catalog has an invalid entry.");
    const name = "name" in entry ? entry.name : undefined;
    const type = "type" in entry ? entry.type : undefined;
    if (type !== "file" || typeof name !== "string") return [];
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    return match ? [match[1]] : [];
  }).sort();
  if (new Set(deploymentIds).size !== deploymentIds.length) {
    throw new Error("Canonical deployment catalog contains duplicate IDs.");
  }

  const catalog: CanonicalDeployment[] = [];
  for (const deploymentId of deploymentIds) {
    const path = deploymentRegistryPath(deploymentId);
    const response = await request(
      `https://raw.githubusercontent.com/${owner}/${repository}/${defaultBranch}/${path}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw new Error(`Canonical registry manifest ${deploymentId} failed (${response.status}).`);
    const text = await boundedResponseText(response, MAX_MANIFEST_RESPONSE_BYTES, "Canonical registry manifest");
    catalog.push({ deploymentId, manifest: parseCanonicalManifest(deploymentId, text) });
  }
  return catalog;
}

export async function verifyCanonicalRegistryFile(
  path: string,
  content: unknown,
  request: typeof fetch = fetch,
  sourceRepository = configuredRegistryRepository,
) {
  const published = await fetchCanonicalRegistryFile(path, request, sourceRepository);
  if (published === undefined) throw new Error(`Registry file is not available at ${path}.`);
  if (published !== canonicalRegistryContent(content)) {
    throw new Error(`Registry file at ${path} does not match the downloaded canonical bytes.`);
  }
  return published;
}

export async function customGitHubManifestSource(value: string, request: typeof fetch = fetch) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("Custom registry links must be HTTPS github.com manifest links.");
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/(.+)\/deployments\/([0-9a-f]{64})\.json$/.exec(url.pathname);
  if (!match) throw new Error("Use a GitHub link to deployments/<deployment-id>.json on the repository default branch.");
  const sourceRepository = `${match[1]}/${match[2]}`;
  const branch = decodeURIComponent(match[3]);
  const resolved = await resolveCanonicalRepository(request, sourceRepository);
  if (branch !== resolved.defaultBranch) throw new Error(`Custom registry manifest must be on its default branch (${resolved.defaultBranch}).`);
  return {
    sourceRepository,
    manifestUrl: `https://raw.githubusercontent.com/${resolved.owner}/${resolved.repository}/${resolved.defaultBranch}/deployments/${match[4]}.json`,
  };
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
