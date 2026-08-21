import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signer: { connected: false, fingerprint: undefined, network: "liquid-testnet", walletReady: true, profiles: [] } as { connected: boolean; fingerprint?: string; network: "liquid-testnet" | "elements-regtest"; profileId?: string; walletReady?: boolean; profiles?: Array<{ id: string; publicIdentity: string; fingerprint: string; network: "liquid-testnet" | "elements-regtest"; label: string; unlocked: boolean; active: boolean }> },
  deployment: undefined as Record<string, unknown> | undefined,
  wallet: undefined as Record<string, unknown> | undefined,
  fundingAddress: undefined as { index: number; confidentialAddress: string } | undefined,
  feeState: "unfunded" as "loading" | "ready" | "pending" | "unfunded" | "error",
  pendingOperation: false,
}));
const disconnect = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const connectSignerMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ fingerprint: "aabbccdd" })));
const switchProfileMock = vi.hoisted(() => vi.fn());
const renameProfileMock = vi.hoisted(() => vi.fn());
const removeProfileMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/amp-signer", async () => {
  return {
    signerSnapshot: () => state.signer,
    subscribeSigner: () => () => undefined,
    disconnectSigner: disconnect,
    connectSigner: connectSignerMock,
    generateMnemonic: vi.fn(() => Promise.resolve("test mnemonic")),
    loadDebugMnemonic: vi.fn(() => undefined),
    saveDebugMnemonic: vi.fn(),
    switchSignerProfile: switchProfileMock,
    renameSignerProfile: renameProfileMock,
    removeSignerProfile: removeProfileMock,
  };
});

vi.mock("../lib/signer-operation-state", () => ({
  hasPendingSignerOperation: () => state.pendingOperation,
}));

vi.mock("../lib/deployments", () => {
  return {
    useActiveDeployment: () => ({ data: state.deployment }),
    useActiveDeploymentId: () => ({ data: undefined }),
    useDeployments: () => ({ data: [] }),
    useSelectDeployment: () => ({ mutate: vi.fn() }),
  };
});

vi.mock("../lib/wallet-query", () => ({
  walletSyncPresentation: (input: { snapshot?: unknown; fetching?: boolean; error?: unknown; syncError?: string }) => ({
    state: input.error || input.syncError ? (input.snapshot ? "stale" : "error") : input.fetching ? "syncing" : input.snapshot ? "synced" : "loading",
    hasSnapshot: Boolean(input.snapshot),
    message: input.syncError,
  }),
  useBaseWalletSync: () => state.wallet ?? {
    data: undefined,
    error: null,
    isPending: false,
    isFetching: false,
    refetch,
  },
  useDeploymentWalletSync: () => state.wallet ?? {
    data: undefined,
    error: null,
    isPending: false,
    isFetching: false,
    refetch,
  },
}));

vi.mock("../lib/wallet-sync", () => ({
  assetBalances: (snapshot: { utxos?: Array<{ status: string; assetId: string; amount: string }> } | undefined) => {
    const balances = new Map<string, { assetId: string; confirmed: bigint; pending: bigint; confirmedUtxos: number; pendingUtxos: number }>();
    for (const utxo of snapshot?.utxos ?? []) {
      if (utxo.status !== "confirmed" && utxo.status !== "unconfirmed") continue;
      const balance = balances.get(utxo.assetId) ?? { assetId: utxo.assetId, confirmed: 0n, pending: 0n, confirmedUtxos: 0, pendingUtxos: 0 };
      if (utxo.status === "confirmed") balance.confirmed += BigInt(utxo.amount);
      else balance.pending += BigInt(utxo.amount);
      balances.set(utxo.assetId, balance);
    }
    return [...balances.values()];
  },
  nextFundingAddress: () => state.fundingAddress,
  feeFundingState: () => state.feeState,
}));

import { WalletPopoverContent, WalletStatus, type WalletPopoverModel } from "./ui";

afterEach(cleanup);

const connectedModel: WalletPopoverModel = {
  fingerprint: "aabbccdd",
  network: "Liquid testnet",
  deploymentSelected: true,
  syncState: "synced",
  lbtcConfirmed: "0.00012",
  lbtcPending: "0.00002",
  otherAssets: [{ assetId: "22".repeat(32), label: "AMP", amount: "42", pending: "3" }],
  utxoCount: 3,
  utxos: [{ outpoint: `${"33".repeat(32)}:1`, status: "confirmed", amount: "0.00012 L-BTC" }],
  receiveIndicator: "External #2 · tlq1qq…abc1234",
};

const profileAIdentity = "aa".repeat(32);
const profileBIdentity = "bb".repeat(32);
const profileA = { id: `liquid-testnet:${profileAIdentity}`, publicIdentity: profileAIdentity, fingerprint: "aabbccdd", network: "liquid-testnet" as const, label: "QA Alice", unlocked: true, active: true };
const profileB = { id: `liquid-testnet:${profileBIdentity}`, publicIdentity: profileBIdentity, fingerprint: "11223344", network: "liquid-testnet" as const, label: "QA Bob", unlocked: true, active: false };

describe("AMP signer wallet popover content", () => {
  it("offers the existing connect action while disconnected", () => {
    const onConnect = vi.fn();
    render(<WalletPopoverContent mnemonicInput="abandon ability" onConnect={onConnect} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "AMP signer wallet" })).toHaveTextContent("No signer connected");
    fireEvent.click(screen.getByRole("button", { name: "Connect signer" }));
    expect(onConnect).toHaveBeenCalledWith("abandon ability");
  });

  it("keeps signer connection progress and errors inside the accessible popover", () => {
    const { rerender } = render(<WalletPopoverContent connecting connectionNotice={{ tone: "progress", message: "Opening the local Liquid testnet signer…" }} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Opening the local Liquid testnet signer…");
    expect(screen.getByRole("status")).toHaveClass("progress");

    rerender(<WalletPopoverContent connectionNotice={{ tone: "error", message: "Recovery phrase is invalid" }} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Connect signer" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Recovery phrase is invalid");
    expect(screen.getByRole("status")).toHaveClass("error");

    rerender(<WalletPopoverContent connectionNotice={{ tone: "success", message: "Signer connected" }} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveClass("success");
  });

  it("offers a saved debug signer without putting its recovery phrase in the input", () => {
    const onConnectSaved = vi.fn();
    render(<WalletPopoverContent savedDebugSignerAvailable onConnect={vi.fn()} onConnectSaved={onConnectSaved} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByLabelText("Recovery phrase or NEW")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Connect saved debug signer" }));
    expect(onConnectSaved).toHaveBeenCalledOnce();
  });

  it("shows remembered public profiles while keeping them locked after reload", () => {
    const onProfileSelect = vi.fn();
    render(<WalletPopoverContent profiles={[{ ...profileA, unlocked: false, active: false }]} selectedProfileId={profileA.id} connectionNetworkLocked onProfileSelect={onProfileSelect} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByLabelText("Remembered signer profile")).toHaveValue(profileA.id);
    expect(screen.getByText(/Only public labels, account identities, fingerprints, and networks survive reload/)).toBeInTheDocument();
    expect(screen.getByLabelText("Recovery phrase or NEW")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Unlock signer profile" })).toBeEnabled();
  });

  it("offers minimal add, rename, and remove profile controls", () => {
    const onAddProfile = vi.fn();
    const onRenameProfile = vi.fn();
    const onRemoveProfile = vi.fn();
    render(<WalletPopoverContent model={{ ...connectedModel, profileLabel: "QA Alice" }} profiles={[profileA]} activeProfileId={profileA.id} onAddProfile={onAddProfile} onRenameProfile={onRenameProfile} onRemoveProfile={onRemoveProfile} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "QA Alice" })).toBeInTheDocument();
    expect(screen.getByText(/derivation account 0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onAddProfile).toHaveBeenCalledOnce();
    expect(onRenameProfile).toHaveBeenCalledOnce();
    expect(onRemoveProfile).toHaveBeenCalledOnce();
  });

  it("shows synchronized balances, pending funds, assets, UTXOs, and a safe address indicator", () => {
    const onRefresh = vi.fn();
    const onDisconnect = vi.fn();
    render(<WalletPopoverContent model={connectedModel} onConnect={vi.fn()} onRefresh={onRefresh} onDisconnect={onDisconnect} />);

    expect(screen.getByText("0.00012")).toBeInTheDocument();
    expect(screen.getByText("+ 0.00002 pending")).toBeInTheDocument();
    expect(screen.getByText("AMP")).toBeInTheDocument();
    expect(screen.getByText("42 + 3 pending")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/External #2/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Current outputs (3)"));
    expect(screen.getByText("0.00012 L-BTC")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/ }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ["loading", "Loading wallet"],
    ["syncing", "Syncing"],
    ["error", "Sync error"],
  ] as const)("renders the %s state", (syncState, label) => {
    render(<WalletPopoverContent model={{ ...connectedModel, syncState, syncError: syncState === "error" ? "Waterfalls unavailable" : undefined }} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    if (syncState === "error") expect(screen.getByRole("status")).toHaveTextContent("Waterfalls unavailable");
  });

  it("renders a clear zero-balance deployment state", () => {
    render(<WalletPopoverContent model={{ ...connectedModel, lbtcConfirmed: "0", lbtcPending: "0", otherAssets: [], utxoCount: 0 }} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByText("Available L-BTC").parentElement).toHaveTextContent("0 L-BTC");
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument();
  });

  it("keeps unknown balances distinct and applies explicit issuer grammar", () => {
    render(<WalletPopoverContent role="issuer" model={{ ...connectedModel, role: "issuer", hasSnapshot: false, syncState: "error", syncError: "No verified snapshot" }} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "AMP signer wallet" })).toHaveClass("issuer");
    expect(screen.getByText("Balance unavailable")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No verified snapshot");
  });

  it("shows the base wallet before a deployment is selected", () => {
    render(<WalletPopoverContent model={{ ...connectedModel, deploymentSelected: false, lbtcConfirmed: "0.00002", otherAssets: [] }} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByText("Available L-BTC").parentElement).toHaveTextContent("0.00002 L-BTC");
    expect(screen.getByText(/Base wallet synchronized/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeEnabled();
  });
});

describe("AMP signer wallet popover interactions", () => {
  beforeEach(() => {
    state.signer = { connected: false, fingerprint: undefined, network: "liquid-testnet" };
    state.deployment = undefined;
    state.wallet = undefined;
    state.fundingAddress = undefined;
    state.feeState = "unfunded";
    state.pendingOperation = false;
    disconnect.mockClear();
    refetch.mockClear();
    connectSignerMock.mockClear();
    switchProfileMock.mockClear();
    renameProfileMock.mockClear();
    removeProfileMock.mockClear();
  });

  it("opens from the status control, traps initial focus in its action, and restores focus on Escape", () => {
    render(<WalletStatus />);
    const trigger = screen.getByRole("button", { name: "Open AMP Signer SDK connection" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "AMP signer wallet" })).toBeInTheDocument();
    expect(screen.getByLabelText("Signer network")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "AMP signer wallet" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("offers an explicit Elements regtest choice on a fresh wallet", () => {
    const onNetwork = vi.fn();
    render(<WalletPopoverContent connectionNetwork="liquid-testnet" onConnectionNetwork={onNetwork} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Signer network"), { target: { value: "elements-regtest" } });
    expect(onNetwork).toHaveBeenCalledWith("elements-regtest");
  });

  it("connects a fresh signer on the explicitly selected Elements regtest network", async () => {
    render(<WalletStatus />);
    fireEvent.click(screen.getByRole("button", { name: "Open AMP Signer SDK connection" }));
    fireEvent.change(screen.getByLabelText("Signer network"), { target: { value: "elements-regtest" } });
    fireEvent.change(screen.getByLabelText("Recovery phrase or NEW"), { target: { value: "test recovery phrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect signer" }));
    await waitFor(() => expect(connectSignerMock).toHaveBeenCalledWith("test recovery phrase", "elements-regtest"));
  });

  it("fails closed when the connected signer network does not match the deployment", () => {
    state.signer = { connected: true, fingerprint: "aabbccdd", network: "liquid-testnet", profileId: profileA.id };
    state.deployment = {
      network: "elements-regtest",
      policyAsset: "11".repeat(32),
      regulatedAsset: "22".repeat(32),
      reissuanceToken: null,
      asset: { ticker: "AMP", precision: 0 },
    };
    render(<WalletStatus role="issuer" />);
    fireEvent.click(screen.getByRole("button", { name: /AMP Signer SDK wallet/ }));
    expect(screen.getByRole("dialog", { name: "AMP signer wallet" })).toHaveClass("issuer");
    expect(screen.getByRole("status")).toHaveTextContent("Reconnect the AMP signer for Elements regtest");
    expect(screen.getByText("Balance unavailable")).toBeInTheDocument();
  });

  it("requires confirmation before switching profiles during a reviewed operation", () => {
    state.pendingOperation = true;
    state.signer = { connected: true, fingerprint: profileA.fingerprint, network: profileA.network, profileId: profileA.id, walletReady: true, profiles: [profileA, profileB] };
    state.deployment = { network: "liquid-testnet", policyAsset: "11".repeat(32), regulatedAsset: "22".repeat(32), reissuanceToken: null, asset: { ticker: "AMP", precision: 0 } };
    state.wallet = { data: { snapshot: { utxos: [], addresses: [] } }, error: null, isPending: false, isFetching: false, refetch };
    render(<WalletStatus />);
    fireEvent.click(screen.getByRole("button", { name: /AMP Signer SDK wallet/ }));
    fireEvent.change(screen.getByLabelText("Active signer profile"), { target: { value: profileB.id } });
    expect(screen.getByRole("alertdialog", { name: "Confirm signer profile switch" })).toBeInTheDocument();
    expect(switchProfileMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch profile" }));
    expect(switchProfileMock).toHaveBeenCalledWith(profileB.id, "liquid-testnet");
  });

  it("unlocks a remembered profile without activating a mismatched phrase", async () => {
    const lockedB = { ...profileB, unlocked: false };
    state.signer = { connected: true, fingerprint: profileA.fingerprint, network: profileA.network, profileId: profileA.id, walletReady: true, profiles: [profileA, lockedB] };
    state.deployment = { network: "liquid-testnet", policyAsset: "11".repeat(32), regulatedAsset: "22".repeat(32), reissuanceToken: null, asset: { ticker: "AMP", precision: 0 } };
    state.wallet = { data: { snapshot: { utxos: [], addresses: [] } }, error: null, isPending: false, isFetching: false, refetch };
    render(<WalletStatus />);
    fireEvent.click(screen.getByRole("button", { name: /AMP Signer SDK wallet/ }));
    fireEvent.change(screen.getByLabelText("Active signer profile"), { target: { value: lockedB.id } });
    expect(screen.getByText("Unlock remembered profile")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Profile recovery phrase or NEW"), { target: { value: "profile b phrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock and switch" }));
    await waitFor(() => expect(connectSignerMock).toHaveBeenCalledWith("profile b phrase", "liquid-testnet", { expectedProfileId: lockedB.id }));
    expect(switchProfileMock).not.toHaveBeenCalled();
  });

  it("rejects profile switching across the active deployment network", () => {
    const regtestProfile = { ...profileB, id: `elements-regtest:${profileBIdentity}`, network: "elements-regtest" as const };
    state.signer = { connected: true, fingerprint: profileA.fingerprint, network: profileA.network, profileId: profileA.id, walletReady: true, profiles: [profileA, regtestProfile] };
    state.deployment = { network: "liquid-testnet", policyAsset: "11".repeat(32), regulatedAsset: "22".repeat(32), reissuanceToken: null, asset: { ticker: "AMP", precision: 0 } };
    state.wallet = { data: { snapshot: { utxos: [], addresses: [] } }, error: null, isPending: false, isFetching: false, refetch };
    render(<WalletStatus />);
    fireEvent.click(screen.getByRole("button", { name: /AMP Signer SDK wallet/ }));
    fireEvent.change(screen.getByLabelText("Active signer profile"), { target: { value: regtestProfile.id } });
    expect(screen.getByRole("status")).toHaveTextContent("requires Liquid testnet");
    expect(switchProfileMock).not.toHaveBeenCalled();
  });

  it("dismisses on an outside pointer interaction", () => {
    render(<WalletStatus />);
    const trigger = screen.getByRole("button", { name: "Open AMP Signer SDK connection" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "AMP signer wallet" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("exposes refresh and disconnect actions for a connected signer", () => {
    const policyAsset = "11".repeat(32);
    state.signer = { connected: true, fingerprint: "aabbccdd", network: "liquid-testnet", profileId: profileA.id };
    state.deployment = {
      network: "liquid-testnet",
      policyAsset,
      regulatedAsset: "22".repeat(32),
      reissuanceToken: null,
      asset: { ticker: "AMP", precision: 0 },
    };
    state.wallet = {
      data: { snapshot: { utxos: [], addresses: [] } },
      error: null,
      isPending: false,
      isFetching: false,
      refetch,
    };
    render(<WalletStatus />);
    fireEvent.click(screen.getByRole("button", { name: /AMP Signer SDK wallet/ }));
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(refetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/ }));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "AMP signer wallet" })).not.toBeInTheDocument();
  });

  it("shows the faucet only after a successful unfunded Liquid-testnet sync", () => {
    const policyAsset = "11".repeat(32);
    state.signer = { connected: true, fingerprint: "aabbccdd", network: "liquid-testnet", profileId: profileA.id };
    state.deployment = {
      network: "liquid-testnet",
      policyAsset,
      regulatedAsset: "22".repeat(32),
      reissuanceToken: null,
      asset: { ticker: "AMP", precision: 0 },
    };
    state.fundingAddress = { index: 2, confidentialAddress: `tlq1${"q".repeat(40)}` };
    state.wallet = { data: { snapshot: { utxos: [], addresses: [] } }, error: null, isPending: false, isFetching: false, refetch };

    const { rerender } = render(<WalletStatus />);
    fireEvent.click(screen.getByRole("button", { name: /AMP Signer SDK wallet/ }));
    const faucet = screen.getByRole("link", { name: /Get testnet L-BTC/ });
    expect(faucet).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(screen.getByText(/public testnet receive address will be sent to liquidtestnet.com/i)).toBeInTheDocument();
    fireEvent.click(faucet);
    expect(screen.getByRole("status")).toHaveTextContent("Liquid testnet faucet opened. Refresh after funding arrives.");

    state.feeState = "pending";
    state.wallet = { data: { snapshot: { utxos: [{ status: "unconfirmed", assetId: policyAsset, amount: "1500" }], addresses: [] } }, error: null, isPending: false, isFetching: false, refetch };
    rerender(<WalletStatus />);
    expect(screen.queryByRole("link", { name: /Get testnet L-BTC/ })).not.toBeInTheDocument();

    state.feeState = "unfunded";
    state.wallet = { data: undefined, error: new Error("Waterfalls unavailable"), isPending: false, isFetching: false, refetch };
    rerender(<WalletStatus />);
    expect(screen.queryByRole("link", { name: /Get testnet L-BTC/ })).not.toBeInTheDocument();
    expect(screen.getByText("Balance unavailable")).toBeInTheDocument();

    state.signer = { connected: true, fingerprint: "aabbccdd", network: "elements-regtest", profileId: `elements-regtest:${profileAIdentity}` };
    state.deployment = { ...state.deployment, network: "elements-regtest" };
    state.wallet = { data: { snapshot: { utxos: [], addresses: [] } }, error: null, isPending: false, isFetching: false, refetch };
    rerender(<WalletStatus />);
    expect(screen.queryByRole("link", { name: /Get testnet L-BTC/ })).not.toBeInTheDocument();
  });
});
