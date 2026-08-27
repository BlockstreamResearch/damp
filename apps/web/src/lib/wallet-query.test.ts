import { describe, expect, it } from "vitest";

import { vi } from "vitest";

vi.mock("./wallet-sync", () => ({
  loadWalletSyncSnapshot: vi.fn(),
  synchronizeBaseWallet: vi.fn(),
  synchronizeDeploymentWallet: vi.fn(),
}));

import { shouldShowPolicyBalanceChecking, walletSyncPresentation } from "./wallet-query";
import type { WalletSyncSnapshot } from "./wallet-sync";

const snapshot = { utxos: [], addresses: [] } as unknown as WalletSyncSnapshot;

describe("wallet synchronization presentation", () => {
  it("shows policy balance progress only for a connected matching signer", () => {
    const pending = {
      signerConnected: true,
      signerMatchesDeployment: true,
      deploymentPublished: true,
      policyPending: true,
      hasPolicy: false,
    };

    expect(shouldShowPolicyBalanceChecking(pending)).toBe(true);
    expect(shouldShowPolicyBalanceChecking({ ...pending, signerConnected: false })).toBe(false);
    expect(shouldShowPolicyBalanceChecking({ ...pending, signerMatchesDeployment: false })).toBe(false);
    expect(shouldShowPolicyBalanceChecking({ ...pending, hasPolicy: true })).toBe(false);
  });

  it("never presents a first-sync failure as a healthy zero or last-good state", () => {
    expect(walletSyncPresentation({ connected: true, error: new Error("Waterfalls unavailable") })).toEqual({
      state: "error",
      hasSnapshot: false,
      message: "Waterfalls unavailable",
    });
  });

  it("uses last-good wording only when a verified snapshot actually exists", () => {
    expect(walletSyncPresentation({ connected: true, snapshot, syncError: "offline" })).toEqual({
      state: "stale",
      hasSnapshot: true,
      message: "offline",
    });
  });

  it("distinguishes disconnected, loading, syncing, and synchronized states", () => {
    expect(walletSyncPresentation({ connected: false }).state).toBe("disconnected");
    expect(walletSyncPresentation({ connected: true, pending: true }).state).toBe("loading");
    expect(walletSyncPresentation({ connected: true, snapshot, fetching: true }).state).toBe("syncing");
    expect(walletSyncPresentation({ connected: true, snapshot }).state).toBe("synced");
  });
});
