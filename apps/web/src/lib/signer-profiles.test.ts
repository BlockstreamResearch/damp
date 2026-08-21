import { beforeEach, describe, expect, it } from "vitest";

import {
  loadSignerProfileMetadata,
  deriveSignerPublicIdentity,
  removeSignerProfileMetadata,
  renameSignerProfileMetadata,
  saveSignerProfileMetadata,
  signerProfileId,
  signerProfilesStorageKey,
  upsertSignerProfileMetadata,
} from "./signer-profiles";

describe("signer profile metadata", () => {
  beforeEach(() => localStorage.clear());

  it("persists stable public identities without any mnemonic material", () => {
    const publicIdentity = "11".repeat(32);
    const id = signerProfileId(publicIdentity, "liquid-testnet");
    const profiles = upsertSignerProfileMetadata([], { id, publicIdentity, fingerprint: "aabbccdd", network: "liquid-testnet" });
    saveSignerProfileMetadata(profiles);
    expect(loadSignerProfileMetadata()).toEqual([{ id, publicIdentity, fingerprint: "aabbccdd", network: "liquid-testnet", label: "Signer aabbccdd" }]);
    expect(localStorage.getItem(signerProfilesStorageKey)).not.toMatch(/mnemonic|recovery|seed|xprv/i);
  });

  it("renames and removes one identity without changing its network or fingerprint", () => {
    const publicIdentity = "22".repeat(32);
    const id = signerProfileId(publicIdentity, "elements-regtest");
    const profiles = upsertSignerProfileMetadata([], { id, publicIdentity, fingerprint: "aabbccdd", network: "elements-regtest" });
    expect(renameSignerProfileMetadata(profiles, id, "  Regtest   QA  ")).toEqual([{ ...profiles[0], label: "Regtest QA" }]);
    expect(removeSignerProfileMetadata(profiles, id)).toEqual([]);
  });

  it("fails closed on malformed, duplicate, or identity-mismatched storage", () => {
    localStorage.setItem(signerProfilesStorageKey, JSON.stringify({ version: 2, profiles: [{ id: "wrong", publicIdentity: "11".repeat(32), fingerprint: "aabbccdd", network: "liquid-testnet", label: "Wrong" }] }));
    expect(loadSignerProfileMetadata()).toEqual([]);
    localStorage.setItem(signerProfilesStorageKey, "not json");
    expect(loadSignerProfileMetadata()).toEqual([]);
    localStorage.clear();
    localStorage.setItem("simplicity-amp:signer-profiles:v1", JSON.stringify({
      version: 1,
      profiles: [{ id: "liquid-testnet:aabbccdd", fingerprint: "aabbccdd", network: "liquid-testnet", label: "Legacy" }],
    }));
    expect(loadSignerProfileMetadata()).toEqual([]);
  });

  it("derives a network-bound 256-bit identity from public wallet material", async () => {
    const liquid = await deriveSignerPublicIdentity(`0014${"11".repeat(20)}`, "liquid-testnet");
    const regtest = await deriveSignerPublicIdentity(`0014${"11".repeat(20)}`, "elements-regtest");
    expect(liquid).toMatch(/^[0-9a-f]{64}$/);
    expect(regtest).toMatch(/^[0-9a-f]{64}$/);
    expect(liquid).not.toBe(regtest);
  });
});
