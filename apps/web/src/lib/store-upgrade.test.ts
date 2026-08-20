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
  it("adds wallet sync storage without deleting existing deployment state", async () => {
    await import("./store");
    const existing = new Set(["deployments", "settings", "snapshots", "receiveRecords", "drafts", "caches"]);
    const created: string[] = [];
    const database = {
      objectStoreNames: { contains: (name: string) => existing.has(name) },
      createObjectStore: (name: string) => created.push(name),
    };

    idbState.options!.upgrade(database);

    expect(idbState.version).toBe(4);
    expect(created).toEqual(["walletSync"]);
    expect(database).not.toHaveProperty("deleteObjectStore");
  });
});
