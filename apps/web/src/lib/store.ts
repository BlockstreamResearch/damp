import { openDB } from "idb";

import type { Deployment, PolicySnapshot, ReceiveRecord } from "./domain";

export type StoredReceiveRecord = { record: ReceiveRecord; derivationIndex: number };

const database = openDB("simplicity-amp-v1", 4, {
  upgrade(db) {
    if (!db.objectStoreNames.contains("deployments")) db.createObjectStore("deployments", { keyPath: "deploymentId" });
    if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
    if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots");
    if (!db.objectStoreNames.contains("receiveRecords")) db.createObjectStore("receiveRecords");
    if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
    if (!db.objectStoreNames.contains("caches")) db.createObjectStore("caches");
    if (!db.objectStoreNames.contains("walletSync")) db.createObjectStore("walletSync");
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

export async function getActiveDeployment(): Promise<Deployment | null> {
  const deploymentId = await getActiveDeploymentId();
  return deploymentId ? (await getDeployment(deploymentId)) ?? null : null;
}

export function snapshotKey(deploymentId: string, verifierScriptHash: string) {
  return `${deploymentId}:${verifierScriptHash}`;
}

export async function getPolicySnapshot(
  deploymentId: string,
  verifierScriptHash: string,
): Promise<PolicySnapshot | undefined> {
  return (await database).get("snapshots", snapshotKey(deploymentId, verifierScriptHash));
}

export async function putPolicySnapshot(snapshot: PolicySnapshot, verifierScriptHash: string) {
  return (await database).put(
    "snapshots",
    snapshot,
    snapshotKey(snapshot.deploymentId, verifierScriptHash),
  );
}

export async function putReceiveRecord(record: ReceiveRecord, derivationIndex: number) {
  return (await database).put(
    "receiveRecords",
    { record, derivationIndex } satisfies StoredReceiveRecord,
    `${record.deploymentId}:${record.ownerPublicKey}`,
  );
}

export async function listReceiveRecords(deploymentId: string): Promise<StoredReceiveRecord[]> {
  const records = await (await database).getAll("receiveRecords") as StoredReceiveRecord[];
  return records.filter(({ record }) => record.deploymentId === deploymentId);
}

export async function getDraft<T>(deploymentId: string, name: string): Promise<T | undefined> {
  return (await database).get("drafts", `${deploymentId}:${name}`);
}

export async function putDraft<T>(deploymentId: string, name: string, value: T) {
  return (await database).put("drafts", value, `${deploymentId}:${name}`);
}

export async function getCachedRecord<T>(key: string): Promise<T | undefined> {
  return (await database).get("caches", key);
}

export async function putCachedRecord<T>(key: string, value: T) {
  return (await database).put("caches", value, key);
}

export async function getWalletSyncRecord<T>(key: string): Promise<T | undefined> {
  return (await database).get("walletSync", key);
}

export async function putWalletSyncRecord<T>(key: string, value: T) {
  return (await database).put("walletSync", value, key);
}
