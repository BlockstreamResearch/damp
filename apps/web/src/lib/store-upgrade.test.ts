import { describe, expect, it, vi } from "vitest";

const idbState = vi.hoisted(() => ({
  version: 0,
  options: undefined as { upgrade: (database: unknown) => void } | undefined,
}));

vi.mock("idb", () => ({
  openDB: (_name: string, version: number, options: { upgrade: (database: unknown) => void }) => {
    idbState.version = version;
    idbState.options = options;
    return Promise.resolve({});
  },
}));

describe("IndexedDB wallet migration", () => {
  it("adds wallet sync storage and removes obsolete receive-record persistence", async () => {
    const store = await import("./store");
    const existing = new Set(["deployments", "settings", "snapshots", "receiveRecords", "drafts", "caches"]);
    const created: string[] = [];
    const deleted: string[] = [];
    const database = {
      objectStoreNames: { contains: (name: string) => existing.has(name) },
      createObjectStore: (name: string) => created.push(name),
      deleteObjectStore: (name: string) => deleted.push(name),
    };

    idbState.options!.upgrade(database);

    expect(idbState.version).toBe(5);
    expect(created).toEqual(["walletSync"]);
    expect(deleted).toEqual(["receiveRecords"]);

    const deploymentId = "11".repeat(32);
    const scriptHash = "22".repeat(32);
    expect(store.snapshotKey(deploymentId, scriptHash)).not.toBe(store.snapshotKey(deploymentId, scriptHash, "example/custom"));
  });
});
