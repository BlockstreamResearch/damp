import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  splitFunding: vi.fn(),
  broadcastTransaction: vi.fn(),
  getDraft: vi.fn(),
  putDraft: vi.fn(),
}));

vi.mock("../lib/amp-signer", async () => {
  const actual = await vi.importActual<typeof import("../lib/amp-signer")>("../lib/amp-signer");
  return {
    ...actual,
    signerSessionRevision: () => 7,
    signerSnapshot: () => ({ connected: true, walletReady: true, profileId: `elements-regtest:${"11".repeat(32)}` }),
    splitFunding: mocks.splitFunding,
  };
});
vi.mock("../lib/chain-wallet", () => ({ broadcastTransaction: mocks.broadcastTransaction }));
vi.mock("../lib/store", () => ({ getDraft: mocks.getDraft, putDraft: mocks.putDraft }));

import { FundingSplitDialog } from "./funding-split-dialog";

const profileId = `elements-regtest:${"11".repeat(32)}`;
const sourceTxid = "cd".repeat(32);
const splitTxid = "ab".repeat(32);
const source = {
  txid: sourceTxid,
  vout: 0,
  transaction: "00",
  spendable: true,
  walletKey: { branch: 0, index: 0 },
};
const destinations = [0, 1].map((index) => ({
  sdk: "test",
  branch: 0,
  index,
  derivationPath: `m/84'/1'/0'/0/${index}`,
  confidentialAddress: `ert1destination${index}${"q".repeat(30)}`,
  scriptPubkey: `00${index}`,
}));
const result = {
  sdk: "test",
  operation: "funding-split" as const,
  pset: "pset",
  transaction: "00",
  txid: splitTxid,
  sourceTxid,
  sourceVout: 0,
  sourceAmount: "100000",
  fee: "500",
  outputs: destinations.map((address, vout) => ({
    vout,
    amount: "49750",
    confidentialAddress: address.confidentialAddress,
    walletKey: { branch: 0, index: vout },
  })),
};

function renderDialog(input: {
  refreshFunding?: () => Promise<{ confirmed: typeof source[]; pending: number }>;
  snapshotStatuses?: Array<{ txid: string; vout: number; status: "confirmed" | "unconfirmed" | "spent" | "orphaned" }>;
} = {}) {
  return render(<FundingSplitDialog
    network="elements-regtest"
    policyAsset={"22".repeat(32)}
    profileId={profileId}
    candidate={source}
    candidateAmount="100000"
    destinations={destinations}
    snapshotStatuses={input.snapshotStatuses ?? []}
    refreshFunding={input.refreshFunding ?? (() => Promise.resolve({ confirmed: [source], pending: 0 }))}
  />);
}

describe("FundingSplitDialog", () => {
  beforeEach(() => {
    mocks.getDraft.mockReset().mockResolvedValue(undefined);
    mocks.putDraft.mockReset().mockResolvedValue(undefined);
    mocks.splitFunding.mockReset().mockResolvedValue(result);
    mocks.broadcastTransaction.mockReset().mockResolvedValue(splitTxid);
  });

  afterEach(cleanup);

  it("previews exact values and signs only once on repeated activation", async () => {
    renderDialog();
    const trigger = await screen.findByRole("button", { name: "Split this output into two" });
    fireEvent.click(trigger);
    expect(screen.getByText("0.000005 L-BTC · 500 sats")).toBeInTheDocument();
    const sign = screen.getByRole("button", { name: "Sign and broadcast split" });
    fireEvent.click(sign);
    fireEvent.click(sign);

    await waitFor(() => expect(mocks.splitFunding).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.broadcastTransaction).toHaveBeenCalledWith({ network: "elements-regtest" }, "00"));
    expect(await screen.findByText(/Waiting for confirmation/)).toBeInTheDocument();
  });

  it("retries the identical signed transaction after a transient broadcast failure", async () => {
    mocks.broadcastTransaction
      .mockRejectedValueOnce(new Error("Esplora request failed (503) for test."))
      .mockResolvedValueOnce(splitTxid);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Split this output into two" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign and broadcast split" }));

    const retry = await screen.findByRole("button", { name: "Retry broadcast" });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.broadcastTransaction).toHaveBeenCalledTimes(2));
    expect(mocks.broadcastTransaction.mock.calls[0]?.[1]).toBe("00");
    expect(mocks.broadcastTransaction.mock.calls[1]?.[1]).toBe("00");
  });

  it("does not sign when another faucet output is already pending", async () => {
    renderDialog({ refreshFunding: () => Promise.resolve({ confirmed: [source], pending: 1 }) });
    fireEvent.click(await screen.findByRole("button", { name: "Split this output into two" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign and broadcast split" }));

    expect(await screen.findByText(/already awaiting confirmation/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close and wait" })).toBeInTheDocument();
    expect(mocks.splitFunding).not.toHaveBeenCalled();
    expect(mocks.broadcastTransaction).not.toHaveBeenCalled();
  });

  it("stops on a broadcast txid mismatch instead of treating it as accepted", async () => {
    mocks.broadcastTransaction.mockResolvedValueOnce("ef".repeat(32));
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Split this output into two" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign and broadcast split" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("different split transaction ID");
    expect(screen.getByRole("button", { name: "Discard and start over" })).toBeInTheDocument();
  });

  it("restores a broadcast receipt and reaches done from confirmed outputs", async () => {
    mocks.getDraft.mockResolvedValueOnce({
      schema: "simplicity-amp-funding-split-receipt-v1",
      signerProfileId: profileId,
      network: "elements-regtest",
      sourceOutpoint: `${sourceTxid}:0`,
      sourceAmount: "100000",
      txid: splitTxid,
      transaction: "00",
      fee: "500",
      outputs: [{ vout: 0, amount: "49750" }, { vout: 1, amount: "49750" }],
      phase: "broadcast",
      createdAt: "2026-08-25T10:00:00.000Z",
    });
    renderDialog({ snapshotStatuses: [
      { txid: splitTxid, vout: 0, status: "confirmed" },
      { txid: splitTxid, vout: 1, status: "confirmed" },
    ] });

    fireEvent.click(await screen.findByRole("button", { name: "View split status" }));
    expect(screen.getByText("Two confirmed funding outputs are ready. Continue to issuance review.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to issuance review" })).toBeInTheDocument();
  });

  it("closes with Escape and restores focus before signing", async () => {
    renderDialog();
    const trigger = await screen.findByRole("button", { name: "Split this output into two" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Split funding for issuance" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
