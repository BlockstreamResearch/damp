import { deploymentManifestSchema, HASH, type DeploymentManifest } from "./domain";
import { sha256Hex } from "./bytes";
import { downloadBlob } from "./download-json";

const configuredRegistryRepository = (import.meta.env.VITE_GITHUB_REGISTRY_REPO as string | undefined) ?? "BlockstreamResearch/damp";
const configuredRegistryRef = registryRef((import.meta.env.VITE_GITHUB_REGISTRY_REF as string | undefined) ?? "main");
const localRegistryBaseUrl = localDevelopmentRegistryUrl(
  import.meta.env.DEV,
  import.meta.env.VITE_LOCAL_REGISTRY_BASE_URL as string | undefined,
);

export function registryRepositoryUrlFor(sourceRepository = configuredRegistryRepository) {
  if (localRegistryBaseUrl && sourceRepository === configuredRegistryRepository) return localRegistryBaseUrl;
  const { owner, repository } = repositoryParts(sourceRepository);
  if (sourceRepository === configuredRegistryRepository) {
    return `https://github.com/${owner}/${repository}/tree/${configuredRegistryRef}/registry`;
  }
  return `https://github.com/${owner}/${repository}`;
}

export const registryRepositoryUrl = registryRepositoryUrlFor();

const MAX_REPOSITORY_RESPONSE_BYTES = 64 * 1024;
const MAX_CATALOG_RESPONSE_BYTES = 1024 * 1024;
const MAX_MANIFEST_RESPONSE_BYTES = 256 * 1024;
const MAX_CANONICAL_DEPLOYMENTS = 128;
const MANIFEST_FETCH_BATCH_SIZE = 4;
const REGISTRY_PREFIX = "registry/";
const DEPLOYMENTS_DIRECTORY = `${REGISTRY_PREFIX}deployments`;

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
  if (!/^registry\/(?:deployments\/[0-9a-f]{64}\.json|policies\/[0-9a-f]{64}\/[0-9a-f]{64}\.json)$/.test(path)) {
    throw new Error("Invalid canonical registry path.");
  }
}

function repositoryParts(repository = configuredRegistryRepository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error("VITE_GITHUB_REGISTRY_REPO must be an owner/repository pair.");
  return { owner: match[1], repository: match[2] };
}

function registryRef(value: string) {
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(value) || value.includes("..")) {
    throw new Error("VITE_GITHUB_REGISTRY_REF must be a valid Git ref.");
  }
  return value;
}

function rawRegistryFileUrl(owner: string, repository: string, ref: string, path: string) {
  return `https://raw.githubusercontent.com/${owner}/${repository}/${ref}/${path}`;
}

function githubApiFailure(response: Response, repository: string) {
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    const retry = Number.isFinite(resetSeconds) ? ` after ${new Date(resetSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " later";
    return new Error(`GitHub's public API rate limit was reached while checking ${repository}. Try again${retry}.`);
  }
  if (response.status === 403) return new Error(`GitHub denied access to ${repository}. Confirm that the registry is public and try again.`);
  return new Error(`Could not load GitHub registry ${repository} (${response.status}).`);
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
  if (sourceRepository === configuredRegistryRepository) {
    return { owner, repository, defaultBranch: configuredRegistryRef };
  }
  const response = await request(`https://api.github.com/repos/${owner}/${repository}`, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw githubApiFailure(response, sourceRepository);
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
  return `${DEPLOYMENTS_DIRECTORY}/${deploymentId}.json`;
}

export async function registryPathForVerifierScript(deploymentId: string, scriptPubkey: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(scriptPubkey)) throw new Error("Verifier script must be lowercase hex.");
  return registryPathForVerifierScriptHash(deploymentId, await sha256Hex(scriptPubkey));
}

export function registryPathForVerifierScriptHash(deploymentId: string, scriptHash: string) {
  const path = `${REGISTRY_PREFIX}policies/${deploymentId}/${scriptHash}.json`;
  assertRegistryPath(path);
  return path;
}

export async function fetchCanonicalRegistryFile(path: string, request: typeof fetch = fetch, sourceRepository = configuredRegistryRepository) {
  assertRegistryPath(path);
  if (localRegistryBaseUrl && sourceRepository === configuredRegistryRepository) {
    const response = await request(new URL(path.slice(REGISTRY_PREFIX.length), localRegistryBaseUrl), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Local test registry fetch failed (${response.status}).`);
    return boundedResponseText(response, MAX_MANIFEST_RESPONSE_BYTES, "Local registry file");
  }
  const resolved = await resolveCanonicalRepository(request, sourceRepository);
  const raw = await request(
    rawRegistryFileUrl(resolved.owner, resolved.repository, resolved.defaultBranch, path),
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (raw.status === 404) return undefined;
  if (!raw.ok) throw new Error(`Canonical registry fetch failed (${raw.status}).`);
  return boundedResponseText(raw, MAX_MANIFEST_RESPONSE_BYTES, "Canonical registry file");
}

async function loadCatalogManifests(
  deploymentIds: string[],
  load: (path: string) => Promise<string | undefined>,
): Promise<CanonicalDeployment[]> {
  const catalog: CanonicalDeployment[] = [];
  for (let offset = 0; offset < deploymentIds.length; offset += MANIFEST_FETCH_BATCH_SIZE) {
    const batch = await Promise.all(deploymentIds.slice(offset, offset + MANIFEST_FETCH_BATCH_SIZE).map(async (deploymentId) => {
      const path = deploymentRegistryPath(deploymentId);
      const text = await load(path);
      if (text === undefined) throw new Error(`Registry deployment ${deploymentId} was listed, but its manifest is missing at ${path}. Refresh the registry.`);
      return { deploymentId, manifest: parseCanonicalManifest(deploymentId, text) };
    }));
    catalog.push(...batch);
  }
  return catalog;
}

/** Discover current manifests under registry/deployments and check their canonical bytes. */
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
    return loadCatalogManifests(uniqueIds, (path) => fetchCanonicalRegistryFile(path, request, sourceRepository));
  }

  const { owner, repository, defaultBranch } = await resolveCanonicalRepository(request, sourceRepository);
  const directory = await request(
    `https://api.github.com/repos/${owner}/${repository}/contents/${DEPLOYMENTS_DIRECTORY}?ref=${encodeURIComponent(defaultBranch)}`,
    { cache: "no-store", headers: { Accept: "application/vnd.github+json" } },
  );
  // Git does not retain empty directories. A missing deployments directory is
  // therefore the canonical representation of an empty registry, not a
  // provider outage. Every other failure remains fail-closed.
  if (directory.status === 404) return [];
  if (!directory.ok) throw githubApiFailure(directory, sourceRepository);
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

  return loadCatalogManifests(deploymentIds, async (path) => {
    const response = await request(
      rawRegistryFileUrl(owner, repository, defaultBranch, path),
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Canonical registry manifest at ${path} failed (${response.status}).`);
    return boundedResponseText(response, MAX_MANIFEST_RESPONSE_BYTES, "Canonical registry manifest");
  });
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
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/blob\/(.+)\/registry\/deployments\/([0-9a-f]{64})\.json$/.exec(url.pathname);
  if (!match) throw new Error("Use a GitHub link to registry/deployments/<deployment-id>.json on the registry branch.");
  const sourceRepository = `${match[1]}/${match[2]}`;
  const branch = decodeURIComponent(match[3]);
  const resolved = await resolveCanonicalRepository(request, sourceRepository);
  if (branch !== resolved.defaultBranch) throw new Error(`Custom registry manifest must be on its default branch (${resolved.defaultBranch}).`);
  return {
    sourceRepository,
    manifestUrl: rawRegistryFileUrl(resolved.owner, resolved.repository, resolved.defaultBranch, deploymentRegistryPath(match[4])),
  };
}

export function downloadCanonicalRegistryFile(path: string, content: unknown) {
  const filename = path.split("/").at(-1);
  if (!filename) throw new Error("Invalid registry path.");
  downloadBlob(canonicalRegistryContent(content), filename);
  return { filename, path };
}

export async function copyCanonicalRegistryFile(path: string, content: unknown) {
  assertRegistryPath(path);
  await navigator.clipboard.writeText(canonicalRegistryContent(content));
  return { path };
}
