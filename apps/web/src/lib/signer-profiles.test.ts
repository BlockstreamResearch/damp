import { beforeEach, describe, expect, it } from "vitest";

import {
  debugSignerProfilesStorageKey,
  deriveSignerPublicIdentity,
  loadDebugSignerProfiles,
  removeDebugSignerProfile,
  renameDebugSignerProfile,
  saveDebugSignerProfiles,
  signerProfileId,
  upsertDebugSignerProfile,
} from "./signer-profiles";

describe("test-only debug signer profiles", () => {
  beforeEach(() => localStorage.clear());

  it("persists normalized debug signer material in the explicit unencrypted storage boundary", () => {
    const publicIdentity = "11".repeat(32);
    const id = signerProfileId(publicIdentity, "liquid-testnet");
    const profiles = upsertDebugSignerProfile([], { id, publicIdentity, fingerprint: "aabbccdd", network: "liquid-testnet", debugMnemonic: "  disposable   test words  " });
    saveDebugSignerProfiles(profiles);
    expect(loadDebugSignerProfiles()).toEqual([{ id, publicIdentity, fingerprint: "aabbccdd", network: "liquid-testnet", label: "Signer aabbccdd", debugMnemonic: "disposable test words" }]);
    expect(localStorage.getItem(debugSignerProfilesStorageKey)).toContain("disposable test words");
  });

  it("renames and removes one identity without changing its network or fingerprint", () => {
    const publicIdentity = "22".repeat(32);
    const id = signerProfileId(publicIdentity, "elements-regtest");
    const profiles = upsertDebugSignerProfile([], { id, publicIdentity, fingerprint: "aabbccdd", network: "elements-regtest", debugMnemonic: "regtest words" });
    expect(renameDebugSignerProfile(profiles, id, "  Regtest   QA  ")).toEqual([{ ...profiles[0], label: "Regtest QA" }]);
    expect(removeDebugSignerProfile(profiles, id)).toEqual([]);
  });

  it("fails closed on malformed, duplicate, or identity-mismatched storage", () => {
    localStorage.setItem(debugSignerProfilesStorageKey, JSON.stringify({ version: 1, profiles: [{ id: "wrong", publicIdentity: "11".repeat(32), fingerprint: "aabbccdd", network: "liquid-testnet", label: "Wrong", debugMnemonic: "words" }] }));
    expect(loadDebugSignerProfiles()).toEqual([]);
    localStorage.setItem(debugSignerProfilesStorageKey, "not json");
    expect(loadDebugSignerProfiles()).toEqual([]);
    localStorage.clear();
    localStorage.setItem("simplicity-amp:signer-profiles:v1", JSON.stringify({
      version: 1,
      profiles: [{ id: "liquid-testnet:aabbccdd", fingerprint: "aabbccdd", network: "liquid-testnet", label: "Legacy" }],
    }));
    expect(loadDebugSignerProfiles()).toEqual([]);

    const publicIdentity = "22".repeat(32);
    const id = signerProfileId(publicIdentity, "liquid-testnet");
    const duplicate = { id, publicIdentity, fingerprint: "aabbccdd", network: "liquid-testnet", label: "Duplicate", debugMnemonic: "test words" };
    localStorage.setItem(debugSignerProfilesStorageKey, JSON.stringify({ version: 1, profiles: [duplicate, duplicate] }));
    expect(loadDebugSignerProfiles()).toEqual([]);
  });

  it("rejects more profiles than the bounded store can reload", () => {
    const profiles = Array.from({ length: 21 }, (_, index) => {
      const publicIdentity = index.toString(16).padStart(64, "0");
      return {
        id: signerProfileId(publicIdentity, "liquid-testnet"),
        publicIdentity,
        fingerprint: index.toString(16).padStart(8, "0"),
        network: "liquid-testnet" as const,
        label: `Signer ${index}`,
        debugMnemonic: `disposable test words ${index}`,
      };
    });
    expect(() => saveDebugSignerProfiles(profiles)).toThrow();
    expect(localStorage.getItem(debugSignerProfilesStorageKey)).toBeNull();
  });

  it("derives a network-bound 256-bit identity from public wallet material", async () => {
    const liquid = await deriveSignerPublicIdentity(`0014${"11".repeat(20)}`, "liquid-testnet");
    const regtest = await deriveSignerPublicIdentity(`0014${"11".repeat(20)}`, "elements-regtest");
    expect(liquid).toMatch(/^[0-9a-f]{64}$/);
    expect(regtest).toMatch(/^[0-9a-f]{64}$/);
    expect(liquid).not.toBe(regtest);
  });
});
