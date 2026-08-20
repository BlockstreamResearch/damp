type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

let accessToken: string | undefined;

const clientId = import.meta.env.VITE_GITHUB_APP_CLIENT_ID as string | undefined;
const registryRepository = (import.meta.env.VITE_GITHUB_REGISTRY_REPO as string | undefined) ?? "BlockstreamResearch/simplicity-amp";

export function canonicalRegistryContent(content: unknown) {
  return `${JSON.stringify(content, null, 2)}\n`;
}

export async function registryPathForVerifierScript(deploymentId: string, scriptPubkey: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(scriptPubkey)) throw new Error("Verifier script must be lowercase hex.");
  const bytes = Uint8Array.from(scriptPubkey.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const scriptHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `policies/${deploymentId}/${scriptHash}.json`;
}

export async function fetchCanonicalRegistryFile(path: string, request: typeof fetch = fetch) {
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

export async function waitForCanonicalRegistryFile(input: {
  path: string;
  content: unknown;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const expected = canonicalRegistryContent(input.content);
  const deadline = Date.now() + (input.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    const published = await fetchCanonicalRegistryFile(input.path);
    if (published === expected) return published;
    if (published !== undefined) throw new Error("Canonical registry path contains different bytes.");
    await new Promise((resolve) => window.setTimeout(resolve, input.pollMs ?? 5_000));
  }
  throw new Error("Timed out waiting for the exact registry snapshot to merge.");
}

export async function startGitHubDeviceFlow(): Promise<DeviceAuthorization> {
  if (!clientId) throw new Error("Set VITE_GITHUB_APP_CLIENT_ID to enable registry publishing.");
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) throw new Error(`GitHub device authorization failed (${response.status}).`);
  return response.json();
}

export async function finishGitHubDeviceFlow(authorization: DeviceAuthorization) {
  if (!clientId) throw new Error("GitHub App client id is not configured.");
  const expiresAt = Date.now() + authorization.expires_in * 1000;
  let interval = authorization.interval;
  while (Date.now() < expiresAt) {
    await new Promise((resolve) => window.setTimeout(resolve, interval * 1000));
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: authorization.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const payload = await response.json();
    if (payload.access_token) {
      accessToken = payload.access_token;
      return;
    }
    if (payload.error === "slow_down") interval += 5;
    else if (payload.error !== "authorization_pending") throw new Error(payload.error_description ?? payload.error);
  }
  throw new Error("GitHub device authorization expired.");
}

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  if (!accessToken) throw new Error("Authorize GitHub for this page session first.");
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message ?? `GitHub request failed (${response.status}).`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function publishRegistryFile(input: {
  path: string;
  content: unknown;
  title: string;
  body: string;
}) {
  const [owner, repository] = registryRepository.split("/");
  const user = await github<{ login: string }>("/user");
  await github(`/repos/${owner}/${repository}/forks`, { method: "POST" }).catch((error) => {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
  });
  const source = await github<{ default_branch: string }>(`/repos/${owner}/${repository}`);
  const reference = await github<{ object: { sha: string } }>(`/repos/${owner}/${repository}/git/ref/heads/${source.default_branch}`);
  const branch = `amp-registry-${Date.now()}`;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ready = await fetch(`https://api.github.com/repos/${user.login}/${repository}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
    });
    if (ready.ok) break;
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }

  await github(`/repos/${user.login}/${repository}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: reference.object.sha }),
  });
  await github(`/repos/${user.login}/${repository}/contents/${input.path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: input.title,
      content: encodeBase64(canonicalRegistryContent(input.content)),
      branch,
    }),
  });
  return github<{ html_url: string }>(`/repos/${owner}/${repository}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: `${user.login}:${branch}`,
      base: source.default_branch,
    }),
  });
}
