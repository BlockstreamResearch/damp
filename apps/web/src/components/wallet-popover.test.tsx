import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signer: { connected: false, fingerprint: undefined as string | undefined, network: "liquid-testnet" as const },
  deployment: undefined as Record<string, unknown> | undefined,
  wallet: undefined as Record<string, unknown> | undefined,
}));
const disconnect = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());

vi.mock("../lib/amp-signer", async () => {
  return {
    signerSnapshot: () => state.signer,
    subscribeSigner: () => () => undefined,
    disconnectSigner: disconnect,
    connectSigner: vi.fn(),
    generateMnemonic: vi.fn(() => Promise.resolve("test mnemonic")),
    loadDebugMnemonic: vi.fn(() => undefined),
    saveDebugMnemonic: vi.fn(),
  };
});

vi.mock("../lib/deployments", () => {
  return {
    useActiveDeployment: () => ({ data: state.deployment }),
    useActiveDeploymentId: () => ({ data: undefined }),
    useDeployments: () => ({ data: [] }),
    useSelectDeployment: () => ({ mutate: vi.fn() }),
  };
});

vi.mock("../lib/wallet-query", () => ({
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
  nextFundingAddress: () => undefined,
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

describe("AMP signer wallet popover content", () => {
  it("offers the existing connect action while disconnected", () => {
    const onConnect = vi.fn();
    render(<WalletPopoverContent mnemonicInput="abandon ability" onConnect={onConnect} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "AMP signer wallet" })).toHaveTextContent("No signer connected");
    fireEvent.click(screen.getByRole("button", { name: "Connect signer" }));
    expect(onConnect).toHaveBeenCalledWith("abandon ability");
  });

  it("keeps signer connection progress and errors inside the accessible popover", () => {
    const { rerender } = render(<WalletPopoverContent connecting connectionMessage="Opening the local Liquid testnet signer…" onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Opening the local Liquid testnet signer…");

    rerender(<WalletPopoverContent connectionMessage="Recovery phrase is invalid" onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Connect signer" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Recovery phrase is invalid");
  });

  it("offers a saved debug signer without putting its recovery phrase in the input", () => {
    const onConnectSaved = vi.fn();
    render(<WalletPopoverContent savedDebugSignerAvailable onConnect={vi.fn()} onConnectSaved={onConnectSaved} onRefresh={vi.fn()} onDisconnect={vi.fn()} />);
    expect(screen.getByLabelText("Recovery phrase or NEW")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Connect saved debug signer" }));
    expect(onConnectSaved).toHaveBeenCalledOnce();
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
    disconnect.mockClear();
    refetch.mockClear();
  });

  it("opens from the status control, traps initial focus in its action, and restores focus on Escape", () => {
    render(<WalletStatus />);
    const trigger = screen.getByRole("button", { name: "Open AMP Signer SDK connection" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "AMP signer wallet" })).toBeInTheDocument();
    expect(screen.getByLabelText("Recovery phrase or NEW")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "AMP signer wallet" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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
    state.signer = { connected: true, fingerprint: "aabbccdd", network: "liquid-testnet" };
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
});
