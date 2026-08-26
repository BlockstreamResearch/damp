import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const hash = (byte: string) => byte.repeat(64);
  const profileId = `liquid-testnet:${hash("a")}`;
  const deployment = {
    schema: "simplicity-amp-registry-v1",
    protocol: "simplicity-amp/v0.1",
    network: "liquid-testnet",
    policyAsset: hash("1"),
    regulatedAsset: hash("2"),
    verifierAsset: hash("3"),
    verifierAssetAmount: 1,
    issuerPublicKey: hash("4"),
    deploymentSalt: hash("5"),
    genesisAnchor: `${hash("6")}:0`,
    asset: { name: "Regulated asset", ticker: "AMP", precision: 2 },
    issuedSupply: "100000",
    supplyMode: "fixed",
    reissuanceToken: null,
    reissuanceEntropy: null,
    userProgramHash: hash("7"),
    governanceProgramHash: hash("8"),
    contractBundleHash: hash("9"),
    deploymentId: hash("a"),
    confirmations: 2,
    activeAnchor: `${hash("b")}:0`,
    publication: "published",
  } as const;
  const policy = {
    schema: "simplicity-amp-registry-v1",
    protocol: "simplicity-amp/v0.1",
    deploymentId: deployment.deploymentId,
    sequence: 0,
    parentPolicyRoot: null,
    parentVerifierScriptHash: null,
    treeDepth: 4,
    setRoot: hash("c"),
    entryCount: 0,
    policyRoot: hash("d"),
    verifierProgramHash: hash("e"),
    verifierScriptPubkey: "51",
    entries: [],
  } as const;
  const recipient = { ownerPublicKey: hash("f"), confidentialAddress: `tlq1${"q".repeat(50)}` } as const;
  const ownAddress = { ...recipient, ownerPublicKey: hash("0"), derivationIndex: 0, scriptPubkey: "51", sdk: "test" };
  const snapshot = {
    version: 3,
    profileId,
    network: "liquid-testnet",
    discoveryProvider: "waterfalls-v4",
    scope: deployment.deploymentId,
    gapLimit: 10,
    scannedThrough: { external: 9, change: 9 },
    tipHeight: 100,
    tipHash: hash("b"),
    syncedAt: "2026-08-22T00:00:00.000Z",
    addresses: [],
    utxos: [
      { source: "holder", txid: hash("c"), vout: 0, transaction: "00", status: "confirmed", assetId: deployment.regulatedAsset, amount: "200", scriptPubkey: "51", assetConfidential: false, valueConfidential: false, holderKey: { derivationIndex: 0, ownerPublicKey: hash("0") } },
      { source: "wallet", txid: hash("d"), vout: 1, transaction: "00", status: "confirmed", assetId: deployment.policyAsset, amount: "5000", scriptPubkey: "51", assetConfidential: false, valueConfidential: false, walletKey: { branch: 0, index: 0 } },
    ],
  } as const;
  const signer = { connected: true, fingerprint: "aabbccdd", network: "liquid-testnet", profileId, walletReady: true, profiles: [] } as const;
  return { deployment, hash, ownAddress, policy, profileId, recipient, signer, snapshot };
});

const calls = vi.hoisted(() => ({
  walletRefetch: vi.fn(),
  liveRefetch: vi.fn(),
  validateAddress: vi.fn(() => Promise.resolve(fixtures.recipient.ownerPublicKey)),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(() => Promise.resolve()), setQueryData: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => queryKey[0] === "transfer-preflight"
    ? { data: { anchor: { txid: fixtures.hash("b"), confirmations: 2, scriptPubkey: "51" }, policy: fixtures.policy }, error: null, isPending: false, isFetching: false, refetch: calls.liveRefetch }
    : { data: null, error: null, isPending: false, isFetching: false, refetch: vi.fn() },
}));

vi.mock("../components/ui", () => ({
  AppShell: ({ children, title }: { children: React.ReactNode; title: string }) => <main><h1>{title}</h1>{children}</main>,
  BackLink: ({ children }: { children: React.ReactNode }) => <a href="/wallet">{children}</a>,
  Panel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Pill: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SafetyNote: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
  SectionHeading: ({ label, title }: { label?: string; title: string }) => <header><span>{label}</span><h2>{title}</h2></header>,
  TechnicalDetails: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  VerifiedLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/operation-receipt", () => ({ OperationReceiptPanel: () => null }));

vi.mock("../lib/amp-signer", () => ({
  signerSnapshot: () => fixtures.signer,
  subscribeSigner: () => () => undefined,
  signTransfer: vi.fn(),
  validateRecipientAddress: calls.validateAddress,
}));

vi.mock("../lib/deployments", () => ({
  deploymentQueryKeys: { all: ["deployments"], active: ["deployment", "active"], activeId: ["deployment", "active-id"] },
  useActiveDeployment: () => ({ data: fixtures.deployment }),
}));
vi.mock("../lib/deployment-import", () => ({ persistPublicDeploymentImport: vi.fn(), validatePublicDeploymentImport: vi.fn() }));

vi.mock("../lib/wallet-query", () => ({
  walletSyncQueryKeys: { wallet: (profileId: string, network: string) => ["wallet-sync", profileId, network] },
  useDeploymentWalletSync: () => ({ data: { snapshot: fixtures.snapshot }, error: null, isPending: false, isFetching: false, refetch: calls.walletRefetch }),
  walletSyncPresentation: vi.fn(),
}));

vi.mock("../lib/wallet-sync", () => ({
  assetBalances: () => [{ assetId: fixtures.deployment.regulatedAsset, confirmed: 200n, pending: 0n, confirmedUtxos: 1, pendingUtxos: 0 }],
  ensureSignerHolderAddress: vi.fn(() => Promise.resolve(fixtures.ownAddress)),
  feeFundingState: vi.fn(),
  nextFundingAddress: vi.fn(),
  synchronizeDeploymentWallet: vi.fn(() => Promise.resolve(fixtures.snapshot)),
}));

vi.mock("../lib/signer-operation-state", () => ({ hasPendingSignerOperation: () => false, setSignerOperationPending: vi.fn() }));
vi.mock("../lib/chain-wallet", () => ({ broadcastTransaction: vi.fn(), liveAnchorUtxo: vi.fn() }));
vi.mock("../lib/esplora", () => ({ esploraUrlForDeployment: () => "https://example.test", requireFreshAnchor: vi.fn(), traverseLiveAnchor: vi.fn() }));
vi.mock("../lib/policy-registry", () => ({ resolvePolicySnapshot: vi.fn() }));
vi.mock("../lib/operation-receipt", () => ({
  createOperationReceipt: vi.fn(), dismissOperationReceipt: vi.fn(), finishOperation: vi.fn(), loadOperationReceipt: vi.fn(),
  operationReceiptQueryKey: (deploymentId: string, operation: string, profileId: string) => ["operation-receipt", deploymentId, operation, profileId],
  saveOperationReceipt: vi.fn(), tryBeginOperation: vi.fn(() => true),
}));

import { WalletSend } from "./wallet";

afterEach(cleanup);

beforeEach(() => {
  calls.validateAddress.mockReset().mockResolvedValue(fixtures.recipient.ownerPublicKey);
  calls.walletRefetch.mockReset().mockResolvedValue({ data: { snapshot: fixtures.snapshot }, error: null });
  calls.liveRefetch.mockReset().mockResolvedValue({ data: { anchor: { txid: fixtures.hash("b"), confirmations: 2, scriptPubkey: "51" }, policy: fixtures.policy }, error: null });
});

describe("WalletSend progressive validation", () => {
  it("rejects malformed inputs inline, clears corrected errors, prevents duplicate review, and shows the canonical review", async () => {
    render(<WalletSend />);
    expect(screen.getByRole("heading", { name: "Build a regulated transfer" })).toBeInTheDocument();
    expect(screen.getByText(/does not prove which deployment manifest/i)).toBeInTheDocument();
    expect(screen.queryByText(/confidential values|confidential transfer/i)).not.toBeInTheDocument();
    const recipient = screen.getByLabelText(/Recipient confidential address/);
    const amount = screen.getByLabelText(/^Amount/);
    const review = screen.getByRole("button", { name: /Review transfer/ });
    expect(review).toBeDisabled();

    calls.validateAddress.mockRejectedValueOnce(new Error("recipient is not a valid Elements address"));
    fireEvent.change(recipient, { target: { value: "not-an-address" } });
    fireEvent.blur(recipient);
    expect(await screen.findByText(/not a valid Elements address/i)).toBeInTheDocument();
    expect(recipient).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(recipient, { target: { value: fixtures.recipient.confidentialAddress } });
    fireEvent.blur(recipient);
    expect(await screen.findByText(/Address verified for the selected DAMP covenant/i)).toBeInTheDocument();
    expect(recipient).toHaveAttribute("aria-invalid", "false");

    fireEvent.change(amount, { target: { value: "0" } });
    fireEvent.blur(amount);
    expect(await screen.findByText(/greater than zero/i)).toBeInTheDocument();
    expect(review).toBeDisabled();

    fireEvent.change(amount, { target: { value: "3.00" } });
    await waitFor(() => expect(screen.queryByText(/greater than zero/i)).not.toBeInTheDocument());
    fireEvent.blur(amount);
    expect(await screen.findByText(/confirmed spendable balance of 2 AMP/i)).toBeInTheDocument();
    expect(amount).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(amount, { target: { value: "1.00" } });
    await waitFor(() => expect(screen.queryByText(/confirmed spendable balance/i)).not.toBeInTheDocument());
    fireEvent.blur(amount);
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(review);

    expect(await screen.findByRole("heading", { name: "Confirm transfer details" })).toBeInTheDocument();
    expect(calls.walletRefetch).toHaveBeenCalledOnce();
    expect(calls.liveRefetch).toHaveBeenCalledOnce();
    expect(screen.getByText("1.00 AMP · 100 base units")).toBeInTheDocument();
    expect(screen.getByText(/tlq1qqqqqqqq…qqqqqqqq/)).toBeInTheDocument();
    expect(screen.getByText(/aabbccdd/)).toBeInTheDocument();
    expect(screen.getByText("Liquid testnet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign and broadcast/ })).toBeEnabled();
  });
});
