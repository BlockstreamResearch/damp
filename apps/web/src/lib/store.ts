import { openDB } from "idb";

import type { Deployment, PolicySnapshot } from "./domain";

// A fresh namespace has one schema. Older browser databases remain untouched.
const database = openDB("simplicity-damp", 1, {
  upgrade(db) {
    db.createObjectStore("deployments", { keyPath: "deploymentId" });
    db.createObjectStore("settings");
    db.createObjectStore("snapshots");
    db.createObjectStore("drafts");
    db.createObjectStore("walletSync");
  },
});

export async function listDeployments(): Promise<Deployment[]> {
  return (await database).getAll("deployments");
}

export async function getDeployment(deploymentId: string): Promise<Deployment | undefined> {
  return (await database).get("deployments", deploymentId);
}

export async function putDeployment(deployment: Deployment) {
  await (await database).put("deployments", deployment);
  const active = await getActiveDeploymentId();
  if (!active) await setActiveDeploymentId(deployment.deploymentId);
}

export async function getActiveDeploymentId(): Promise<string | null> {
  const deploymentId = await (await database).get("settings", "activeDeploymentId");
  return deploymentId ?? null;
}

export async function setActiveDeploymentId(deploymentId: string) {
  if (!await getDeployment(deploymentId)) throw new Error("Cannot activate an unknown deployment.");
  await (await database).put("settings", deploymentId, "activeDeploymentId");
}

export function snapshotKey(deploymentId: string, verifierScriptHash: string, registryRepository?: string) {
  return `${deploymentId}:${registryRepository ?? "official"}:${verifierScriptHash}`;
}

export async function getPolicySnapshot(
  deploymentId: string,
  verifierScriptHash: string,
  registryRepository?: string,
): Promise<PolicySnapshot | undefined> {
  return (await database).get("snapshots", snapshotKey(deploymentId, verifierScriptHash, registryRepository));
}

export async function putPolicySnapshot(snapshot: PolicySnapshot, verifierScriptHash: string, registryRepository?: string) {
  return (await database).put(
    "snapshots",
    snapshot,
    snapshotKey(snapshot.deploymentId, verifierScriptHash, registryRepository),
  );
}

export async function getDraft<T>(deploymentId: string, name: string): Promise<T | undefined> {
  return (await database).get("drafts", `${deploymentId}:${name}`);
}

export async function putDraft<T>(deploymentId: string, name: string, value: T) {
  return (await database).put("drafts", value, `${deploymentId}:${name}`);
}

export async function putTxidKeyedReceipt<T extends { txid: string }>(
  deploymentId: string,
  operation: string,
  signerProfileId: string,
  receipt: T,
) {
  const db = await database;
  const transaction = db.transaction("drafts", "readwrite");
  await Promise.all([
    transaction.store.put(receipt, `${deploymentId}:receipt:${operation}:${signerProfileId}:${receipt.txid}`),
    transaction.store.put(receipt, `${deploymentId}:receipt:${operation}:${signerProfileId}:latest`),
  ]);
  await transaction.done;
}

export async function getLatestReceipt<T>(deploymentId: string, operation: string, signerProfileId: string): Promise<T | undefined> {
  return (await database).get("drafts", `${deploymentId}:receipt:${operation}:${signerProfileId}:latest`);
}

export async function clearLatestReceipt(deploymentId: string, operation: string, signerProfileId: string) {
  return (await database).delete("drafts", `${deploymentId}:receipt:${operation}:${signerProfileId}:latest`);
}

export async function getWalletSyncRecord<T>(key: string): Promise<T | undefined> {
  return (await database).get("walletSync", key);
}

export async function putWalletSyncRecord<T>(key: string, value: T) {
  return (await database).put("walletSync", value, key);
}

export async function listDeploymentPolicies(deploymentId: string): Promise<PolicySnapshot[]> {
  const snapshots: PolicySnapshot[] = await (await database).getAll("snapshots");
  return snapshots.filter((snapshot) => snapshot.deploymentId === deploymentId);
}
