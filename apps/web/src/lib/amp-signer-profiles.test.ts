import { beforeEach, describe, expect, it, vi } from "vitest";

const freed = vi.hoisted(() => new Set<string>());
const instances = vi.hoisted(() => ({ next: 0 }));

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
      this.sessionKey = `${network}:${mnemonic}:${++instances.next}`;
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
    instances.next = 0;
    vi.resetModules();
  });

  it("switches A to B to A directly and restores persisted debug profiles after reload", async () => {
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

    await signer.switchSignerProfile(aliceId, "liquid-testnet");
    expect(signer.signerSnapshot()).toMatchObject({ fingerprint: "aabbccdd", walletReady: false });
    expect((await signer.deriveWalletAddress(0, 0)).scriptPubkey).toBe(`0014${"11".repeat(20)}`);
    await expect(signer.switchSignerProfile(bobId, "elements-regtest")).rejects.toThrow(/requires elements-regtest/i);
    expect(signer.signerSnapshot().fingerprint).toBe("aabbccdd");

    signer.disconnectSigner();
    expect(signer.signerSnapshot().profiles).toHaveLength(2);
    expect(signer.signerSnapshot().profiles.every((profile) => !Object.hasOwn(profile, "debugMnemonic"))).toBe(true);
    await signer.switchSignerProfile(aliceId, "liquid-testnet");
    expect(signer.signerSnapshot()).toMatchObject({ connected: true, fingerprint: "aabbccdd", walletReady: false });
    signer.disconnectSigner();

    vi.resetModules();
    const reloaded = await import("./amp-signer");
    expect(reloaded.signerSnapshot()).toMatchObject({ connected: false, walletReady: false });
    expect(reloaded.signerSnapshot().profiles.map(({ fingerprint, active }) => ({ fingerprint, active }))).toEqual([
      { fingerprint: "aabbccdd", active: false },
      { fingerprint: "11223344", active: false },
    ]);
    await reloaded.switchSignerProfile(bobId, "liquid-testnet");
    expect(reloaded.signerSnapshot()).toMatchObject({ connected: true, fingerprint: "11223344", walletReady: false });
    expect((await reloaded.deriveWalletAddress(0, 0)).scriptPubkey).toBe(`0014${"22".repeat(20)}`);

    const debugStorage = localStorage.getItem("simplicity-amp:debug-signer-profiles:v1");
    expect(debugStorage).toContain("alice phrase");
    expect(debugStorage).toContain("bob phrase");
    expect(debugStorage).not.toContain("mainnet");
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

    await signer.switchSignerProfile(aliceId, "liquid-testnet");
    expect((await signer.deriveWalletAddress(0, 0)).scriptPubkey).toBe(`0014${"11".repeat(20)}`);
  });

  it("fails closed when persisted debug material no longer matches its public profile identity", async () => {
    const signer = await import("./amp-signer");
    await signer.connectSigner("alice phrase", "liquid-testnet");
    const aliceId = signer.signerSnapshot().profileId!;
    signer.disconnectSigner();

    const key = "simplicity-amp:debug-signer-profiles:v1";
    const stored = JSON.parse(localStorage.getItem(key)!) as { profiles: Array<{ debugMnemonic: string }> };
    stored.profiles[0]!.debugMnemonic = "bob phrase";
    localStorage.setItem(key, JSON.stringify(stored));

    vi.resetModules();
    const reloaded = await import("./amp-signer");
    await expect(reloaded.switchSignerProfile(aliceId, "liquid-testnet")).rejects.toThrow(/does not match its profile identity/i);
    expect(reloaded.signerSnapshot()).toMatchObject({ connected: false, walletReady: false });
  });
});
