import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/store", () => ({
  clearLatestReceipt: vi.fn(),
  getLatestReceipt: vi.fn(),
  putTxidKeyedReceipt: vi.fn(),
}));

import { OperationReceiptPanel } from "./operation-receipt";

afterEach(cleanup);

const receipt = {
  schema: "simplicity-amp-operation-receipt-v3",
  deploymentId: "11".repeat(32),
  signerProfileId: `liquid-testnet:${"aa".repeat(32)}`,
  operation: "transfer",
  txid: "22".repeat(32),
  amount: "123",
  ticker: "AMP",
  createdAt: "2026-08-21T10:00:00.000Z",
} as const;

describe("operation receipt panel", () => {
  it("renders a terminal txid receipt and deliberate reset action", () => {
    const onReset = vi.fn();
    render(<OperationReceiptPanel receipt={receipt} network="liquid-testnet" amountLabel="1.23 AMP" resetLabel="Start a new transfer" tone="holder" onReset={onReset} />);

    expect(screen.getByRole("status")).toHaveTextContent("prevents the reviewed operation from being signed or broadcast again");
    expect(screen.getByRole("link", { name: /View transaction/ })).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    fireEvent.click(screen.getByRole("button", { name: "Start a new transfer" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("uses issuer action grammar and omits a public explorer on regtest", () => {
    render(<OperationReceiptPanel receipt={{ ...receipt, operation: "reissuance" }} network="elements-regtest" amountLabel="9 AMP base units" resetLabel="Start a new reissuance" tone="issuer" onReset={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Start a new reissuance" })).toHaveClass("issuer-primary");
    expect(screen.queryByRole("link", { name: /View transaction/ })).not.toBeInTheDocument();
  });
});
