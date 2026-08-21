import { beforeEach, describe, expect, it, vi } from "vitest";

const freed = vi.hoisted(() => new Set<string>());

vi.mock("../generated/amp-signer/simplicity_amp_signer", () => ({
  default: vi.fn(() => Promise.resolve()),
  AmpSigner: class FakeAmpSigner {
    readonly fingerprint: string;
    readonly walletScript: string;
    readonly sessionKey: string;
    constructor(readonly mnemonic: string, readonly network: string) {
      this.fingerprint = mnemonic.includes("bob") ? "11223344" : "aabbccdd";
      const identityByte = mnemonic.includes("collision") ? "33" : mnemonic.includes("bob") ? "22" : "11";
      this.walletScript = `0014${identityByte.repeat(20)}`;
      this.sessionKey = `${network}:${mnemonic}`;
    }
    info() { return { fingerprint: this.fingerprint }; }
    deriveWalletAddress(branch: number, index: number) {
      if (freed.has(this.sessionKey)) throw new Error("freed signer");
      return { sdk: "test", branch, index, derivationPath: `m/${branch}/${index}`, confidentialAddress: `${this.fingerprint}-${branch}-${index}`, scriptPubkey: this.walletScript };
    }
    free() { freed.add(this.sessionKey); }
  },
  generateMnemonic: vi.fn(() => "generated words"),
}));

describe("in-memory signer profile sessions", () => {
  beforeEach(() => {
    localStorage.clear();
    freed.clear();
    vi.resetModules();
  });

  it("switches A to B to A with partitioned readiness and reloads only locked public metadata", async () => {
    const signer = await import("./amp-signer");
    await signer.connectSigner("alice phrase", "liquid-testnet");
    const aliceId = signer.signerSnapshot().profileId!;
    signer.markSignerWalletReady(aliceId, "liquid-testnet");
    expect(signer.signerSnapshot()).toMatchObject({ fingerprint: "aabbccdd", walletReady: true });

    await signer.connectSigner("bob phrase", "liquid-testnet");
    const bobId = signer.signerSnapshot().profileId!;
    expect(bobId).not.toBe(aliceId);
    expect(signer.signerSnapshot()).toMatchObject({ fingerprint: "11223344", walletReady: false });
    expect((await signer.deriveWalletAddress(0, 0)).scriptPubkey).toBe(`0014${"22".repeat(20)}`);

    signer.switchSignerProfile(aliceId, "liquid-testnet");
    expect(signer.signerSnapshot()).toMatchObject({ fingerprint: "aabbccdd", walletReady: false });
    expect((await signer.deriveWalletAddress(0, 0)).scriptPubkey).toBe(`0014${"11".repeat(20)}`);
    expect(() => signer.switchSignerProfile(bobId, "elements-regtest")).toThrow(/requires elements-regtest/i);
    expect(signer.signerSnapshot().fingerprint).toBe("aabbccdd");

    signer.disconnectSigner();
    expect(signer.signerSnapshot().profiles.every((profile) => !profile.unlocked)).toBe(true);
    expect(() => signer.switchSignerProfile(aliceId, "liquid-testnet")).toThrow(/locked/i);

    vi.resetModules();
    const reloaded = await import("./amp-signer");
    expect(reloaded.signerSnapshot()).toMatchObject({ connected: false, walletReady: false });
    expect(reloaded.signerSnapshot().profiles.map(({ fingerprint, unlocked }) => ({ fingerprint, unlocked }))).toEqual([
      { fingerprint: "aabbccdd", unlocked: false },
      { fingerprint: "11223344", unlocked: false },
    ]);
    expect(localStorage.getItem("simplicity-amp:signer-profiles:v2")).not.toMatch(/alice phrase|bob phrase/);
  });

  it("keeps sessions isolated when two signers share the same short fingerprint", async () => {
    const signer = await import("./amp-signer");
    await signer.connectSigner("alice phrase", "liquid-testnet");
    const aliceId = signer.signerSnapshot().profileId!;
    await signer.connectSigner("collision phrase", "liquid-testnet");
    const collisionId = signer.signerSnapshot().profileId!;

    expect(signer.signerSnapshot().fingerprint).toBe("aabbccdd");
    expect(collisionId).not.toBe(aliceId);
    expect(signer.signerSnapshot().profiles).toHaveLength(2);
    expect((await signer.deriveWalletAddress(0, 0)).scriptPubkey).toBe(`0014${"33".repeat(20)}`);

    signer.switchSignerProfile(aliceId, "liquid-testnet");
    expect((await signer.deriveWalletAddress(0, 0)).scriptPubkey).toBe(`0014${"11".repeat(20)}`);
  });

  it("does not activate or remember a phrase that fails a selected-profile identity check", async () => {
    const signer = await import("./amp-signer");
    await signer.connectSigner("alice phrase", "liquid-testnet");
    const aliceId = signer.signerSnapshot().profileId!;
    await expect(signer.connectSigner("bob phrase", "liquid-testnet", { expectedProfileId: aliceId })).rejects.toThrow(/does not unlock/i);
    expect(signer.signerSnapshot().fingerprint).toBe("aabbccdd");
    expect(signer.signerSnapshot().profiles).toHaveLength(1);
  });
});
