import { buildBlacklist, preparePolicy, validatePolicySnapshot } from "./damp-signer";
import type { BlacklistEntry, Deployment, PolicySnapshot } from "./domain";
import { policySnapshotSchema, publicManifest, smallestTreeDepth } from "./domain";
import { canonicalRegistryContent, fetchCanonicalRegistryFile, registryPathForVerifierScript, registryPathForVerifierScriptHash } from "./github";
import { sha256Hex } from "./bytes";
export { sha256Hex } from "./bytes";
import { putPolicySnapshot } from "./store";

export async function resolvePolicySnapshot(
  deployment: Deployment,
  liveVerifierScript: string,
): Promise<PolicySnapshot> {
  const verifierScriptHash = await sha256Hex(liveVerifierScript);
  const path = await registryPathForVerifierScript(deployment.deploymentId, liveVerifierScript);
  const raw = await fetchCanonicalRegistryFile(path, fetch, deployment.registryRepository);
  if (!raw) throw new Error("The live verifier policy is not published in the canonical registry.");
  const snapshot = policySnapshotSchema.parse(JSON.parse(raw));
  if (raw !== canonicalRegistryContent(snapshot)) {
    throw new Error("The live verifier policy is not encoded as canonical registry bytes.");
  }
  if (snapshot.deploymentId !== deployment.deploymentId) throw new Error("Policy belongs to another deployment.");
  if (snapshot.verifierScriptPubkey !== liveVerifierScript) throw new Error("Policy script does not match the live anchor.");
  await validatePolicySnapshot(snapshot);
  await validateBundledPolicy(deployment, snapshot);
  await putPolicySnapshot(snapshot, verifierScriptHash, deployment.registryRepository);
  return snapshot;
}

export async function resolvePolicyHistory(
  deployment: Deployment,
  latest: PolicySnapshot,
): Promise<PolicySnapshot[]> {
  const history = [policySnapshotSchema.parse(latest)];
  let child = history[0];
  for (let transitions = 0; child.sequence > 0; transitions += 1) {
    if (transitions >= 512) throw new Error("Policy history exceeds the 512-transition audit limit.");
    const parentScriptHash = child.parentVerifierScriptHash;
    const parentPolicyRoot = child.parentPolicyRoot;
    if (!parentScriptHash || !parentPolicyRoot) throw new Error("Policy history is missing a predecessor commitment.");
    const path = registryPathForVerifierScriptHash(deployment.deploymentId, parentScriptHash);
    const raw = await fetchCanonicalRegistryFile(path, fetch, deployment.registryRepository);
    if (!raw) throw new Error(`Policy predecessor for sequence ${child.sequence} is not published in the canonical registry.`);
    const parent = policySnapshotSchema.parse(JSON.parse(raw));
    if (raw !== canonicalRegistryContent(parent)) throw new Error("A policy predecessor is not encoded as canonical registry bytes.");
    if (parent.deploymentId !== deployment.deploymentId || parent.protocol !== deployment.protocol) {
      throw new Error("Policy predecessor belongs to another deployment or protocol.");
    }
    if (parent.sequence + 1 !== child.sequence || parent.policyRoot !== parentPolicyRoot) {
      throw new Error("Policy predecessor does not match the successor commitment.");
    }
    if (await sha256Hex(parent.verifierScriptPubkey) !== parentScriptHash) {
      throw new Error("Policy predecessor script does not match its committed registry path.");
    }
    await validatePolicySnapshot(parent);
    await validateBundledPolicy(deployment, parent);
    await putPolicySnapshot(parent, parentScriptHash, deployment.registryRepository);
    history.unshift(parent);
    child = parent;
  }
  return history;
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
    throw new Error("Policy snapshot does not match the bundled DAMP contracts.");
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
    schema: "simplicity-damp-registry-v1",
    protocol: deployment.protocol,
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
