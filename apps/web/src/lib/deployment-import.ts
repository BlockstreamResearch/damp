import {
  deriveAmpKey,
  signerSessionRevision,
  signerSnapshot,
  validateDeployment,
} from "./amp-signer";
import {
  deploymentManifestSchema,
  localDeploymentSchema,
  type Deployment,
  type DeploymentManifest,
  type PolicySnapshot,
} from "./domain";
import { esploraUrlForDeployment, traverseLiveAnchor } from "./esplora";
import { deploymentRegistryPath, verifyCanonicalRegistryFile } from "./github";
import { resolvePolicySnapshot, sha256Hex } from "./policy-registry";
import {
  getDeployment,
  putDeployment,
  putPolicySnapshot,
  setActiveDeploymentId,
} from "./store";

const MAX_MANIFEST_BYTES = 256 * 1024;

export type PublicDeploymentImport = {
  deployment: Deployment;
  snapshot: PolicySnapshot;
};

export type PublicImportDependencies = {
  request: typeof fetch;
  validateDeployment: typeof validateDeployment;
  verifyCanonicalManifest: typeof verifyCanonicalRegistryFile;
  traverseAnchor: typeof traverseLiveAnchor;
  resolvePolicy: typeof resolvePolicySnapshot;
};

const defaultDependencies: PublicImportDependencies = {
  request: fetch,
  validateDeployment,
  verifyCanonicalManifest: verifyCanonicalRegistryFile,
  traverseAnchor: traverseLiveAnchor,
  resolvePolicy: resolvePolicySnapshot,
};

export async function readPublicManifestSource(value: string, request: typeof fetch = fetch) {
  const source = value.trim();
  if (!source) throw new Error("Paste a deployment manifest or HTTPS URL.");
  if (source.startsWith("{")) return JSON.parse(source) as unknown;

  const url = new URL(source);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Deployment URLs must use HTTPS (or loopback HTTP for local testing).");
  }
  const response = await request(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Deployment manifest request failed (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
    throw new Error("Deployment manifest exceeds 256 KiB.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Deployment manifest exceeds 256 KiB.");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function validatePublicDeploymentImport(
  value: string,
  dependencies: Partial<PublicImportDependencies> = {},
  registryRepository?: string,
): Promise<PublicDeploymentImport> {
  const deps = { ...defaultDependencies, ...dependencies };
  const raw = await readPublicManifestSource(value, deps.request);
  const manifest = deploymentManifestSchema.parse(raw);
  const deploymentId = await deps.validateDeployment(manifest);
  if (registryRepository) {
    await deps.verifyCanonicalManifest(deploymentRegistryPath(deploymentId), manifest, deps.request, registryRepository);
  } else {
    await deps.verifyCanonicalManifest(deploymentRegistryPath(deploymentId), manifest);
  }

  // Public import deliberately creates no issuer-key locator. The temporary
  // published state is used only to resolve and validate the canonical policy;
  // nothing is persisted until all checks below succeed.
  const temporary = localDeploymentSchema.parse({
    ...manifest,
    deploymentId,
    confirmations: 0,
    publication: "published",
    registryRepository,
  });
  const anchor = await deps.traverseAnchor(temporary, esploraUrlForDeployment(temporary));
  if (anchor.live.confirmations < 1) throw new Error("Live anchor must be confirmed before import.");
  const snapshot = await deps.resolvePolicy(temporary, anchor.live.scriptPubkey);
  const deployment = localDeploymentSchema.parse({
    ...temporary,
    confirmations: anchor.live.confirmations,
    activeAnchor: `${anchor.live.txid}:0`,
  });
  return { deployment, snapshot };
}

export async function persistPublicDeploymentImport(result: PublicDeploymentImport) {
  const {
    issuerDerivationIndex: _untrustedIssuerDerivationIndex,
    issuerFingerprint: _untrustedIssuerFingerprint,
    issuerProfileId: _untrustedIssuerProfileId,
    ...publicIncoming
  } = result.deployment;
  const incoming = localDeploymentSchema.parse(publicIncoming);
  const existing = await getDeployment(incoming.deploymentId);
  // A public import can retain authority already attached locally, but can
  // never create or replace it from public data.
  const deployment = localDeploymentSchema.parse({
    ...incoming,
    issuerDerivationIndex: existing?.issuerProfileId ? existing.issuerDerivationIndex : undefined,
    issuerFingerprint: existing?.issuerProfileId && existing.issuerDerivationIndex !== undefined ? existing.issuerFingerprint : undefined,
    issuerProfileId: existing?.issuerDerivationIndex !== undefined ? existing.issuerProfileId : undefined,
  });
  await putDeployment(deployment);
  await setActiveDeploymentId(deployment.deploymentId);
  await putPolicySnapshot(result.snapshot, await sha256Hex(result.snapshot.verifierScriptPubkey), deployment.registryRepository);
  return deployment;
}

export async function attachIssuerControl(deployment: Deployment) {
  const selected = localDeploymentSchema.parse(deployment);
  const signer = signerSnapshot();
  if (!signer.connected || !signer.fingerprint || !signer.profileId) throw new Error("Connect the DAMP signer first.");
  if (signer.network !== selected.network) {
    throw new Error(`Reconnect the DAMP signer for ${selected.network}.`);
  }
  const revision = signerSessionRevision();
  const issuer = await deriveAmpKey(selected.deploymentSalt, "issuer", selected.network);
  const current = signerSnapshot();
  if (signerSessionRevision() !== revision || current.profileId !== signer.profileId) {
    throw new Error("The active signer profile changed while attaching issuer control. Try again.");
  }
  if (issuer.publicKey !== selected.issuerPublicKey) {
    throw new Error("Connected signer does not control this deployment's issuer key.");
  }
  const attached = localDeploymentSchema.parse({
    ...selected,
    issuerDerivationIndex: issuer.derivationIndex,
    issuerFingerprint: signer.fingerprint,
    issuerProfileId: signer.profileId,
  });
  await putDeployment(attached);
  return attached;
}

export function publicImportHasIssuerAuthority(deployment: DeploymentManifest | Deployment) {
  return "issuerDerivationIndex" in deployment
    && deployment.issuerDerivationIndex !== undefined
    && "issuerFingerprint" in deployment
    && deployment.issuerFingerprint !== undefined
    && "issuerProfileId" in deployment
    && deployment.issuerProfileId !== undefined;
}
