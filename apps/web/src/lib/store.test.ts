import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  name: "", version: 0,
  options: undefined as { upgrade: (database: unknown) => void } | undefined,
}));

vi.mock("idb", () => ({
  openDB: (name: string, version: number, options: { upgrade: (database: unknown) => void }) => {
    Object.assign(state, { name, version, options });
    return Promise.resolve({});
  },
}));

describe("current public-data storage", () => {
  it("creates only the current stores in a fresh namespace", async () => {
    const store = await import("./store");
    const createObjectStore = vi.fn();
    state.options!.upgrade({ createObjectStore });
    expect(state.name).toBe("simplicity-damp");
    expect(state.version).toBe(1);
    expect(createObjectStore.mock.calls).toEqual([
      ["deployments", { keyPath: "deploymentId" }],
      ["settings"], ["snapshots"], ["drafts"], ["walletSync"],
    ]);

    const deploymentId = "11".repeat(32), scriptHash = "22".repeat(32);
    expect(store.snapshotKey(deploymentId, scriptHash))
      .not.toBe(store.snapshotKey(deploymentId, scriptHash, "example/custom"));
  });
});
