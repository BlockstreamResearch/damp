import { buildBlacklist, preparePolicy, validatePolicySnapshot } from "./amp-signer";
import type { BlacklistEntry, Deployment, PolicySnapshot } from "./domain";
import { policySnapshotSchema, publicManifest, smallestTreeDepth } from "./domain";
import { fetchCanonicalRegistryFile, registryPathForVerifierScript } from "./github";
import { getPolicySnapshot, putPolicySnapshot } from "./store";

export async function resolvePolicySnapshot(
  deployment: Deployment,
  liveVerifierScript: string,
): Promise<PolicySnapshot> {
  const verifierScriptHash = await sha256Hex(liveVerifierScript);
  const cached = await getPolicySnapshot(deployment.deploymentId, verifierScriptHash);
  if (cached) {
    await validatePolicySnapshot(cached);
    await validateBundledPolicy(deployment, cached);
    return cached;
  }
  const path = await registryPathForVerifierScript(deployment.deploymentId, liveVerifierScript);
  const raw = await fetchCanonicalRegistryFile(path);
  if (!raw) throw new Error("The live verifier policy is not published in the canonical registry.");
  const snapshot = policySnapshotSchema.parse(JSON.parse(raw));
  if (snapshot.deploymentId !== deployment.deploymentId) throw new Error("Policy belongs to another deployment.");
  if (snapshot.verifierScriptPubkey !== liveVerifierScript) throw new Error("Policy script does not match the live anchor.");
  await validatePolicySnapshot(snapshot);
  await validateBundledPolicy(deployment, snapshot);
  await putPolicySnapshot(snapshot, verifierScriptHash);
  return snapshot;
}

async function validateBundledPolicy(deployment: Deployment, snapshot: PolicySnapshot) {
  const prepared = await preparePolicy({
    deployment: publicManifest(deployment),
    treeDepth: snapshot.treeDepth,
    setRoot: snapshot.setRoot,
    entryCount: snapshot.entryCount,
  });
  if (
    prepared.policyRoot !== snapshot.policyRoot
    || prepared.verifierProgramHash !== snapshot.verifierProgramHash
    || prepared.verifierScriptPubkey !== snapshot.verifierScriptPubkey
  ) {
    throw new Error("Policy snapshot does not match the bundled AMP contracts.");
  }
}

export async function buildSuccessorPolicy(
  deployment: Deployment,
  current: PolicySnapshot | undefined,
  entries: BlacklistEntry[],
): Promise<PolicySnapshot> {
  const treeDepth = smallestTreeDepth(entries.length);
  const built = await buildBlacklist(entries, treeDepth);
  const prepared = await preparePolicy({
    deployment: publicManifest(deployment),
    treeDepth,
    setRoot: built.setRoot,
    entryCount: built.entryCount,
  });
  const snapshot = policySnapshotSchema.parse({
    schema: "simplicity-amp-registry-v1",
    protocol: "simplicity-amp/v0.1",
    deploymentId: deployment.deploymentId,
    sequence: current ? current.sequence + 1 : 0,
    parentPolicyRoot: current?.policyRoot ?? null,
    parentVerifierScriptHash: current ? await sha256Hex(current.verifierScriptPubkey) : null,
    treeDepth,
    setRoot: built.setRoot,
    entryCount: built.entryCount,
    policyRoot: built.policyRoot,
    verifierProgramHash: prepared.verifierProgramHash,
    verifierScriptPubkey: prepared.verifierScriptPubkey,
    entries: built.entries,
  });
  await validatePolicySnapshot(snapshot);
  return snapshot;
}

export async function sha256Hex(hex: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error("Expected lowercase hexadecimal bytes.");
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
