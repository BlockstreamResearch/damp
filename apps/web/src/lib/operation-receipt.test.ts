import { beforeEach, describe, expect, it, vi } from "vitest";

const receipts = vi.hoisted(() => new Map<string, unknown>());

vi.mock("./store", () => ({
  putTxidKeyedReceipt: (deploymentId: string, operation: string, receipt: { txid: string }) => {
    receipts.set(`${deploymentId}:${operation}:${receipt.txid}`, structuredClone(receipt));
    receipts.set(`${deploymentId}:${operation}:latest`, structuredClone(receipt));
    return Promise.resolve();
  },
  getLatestReceipt: (deploymentId: string, operation: string) => Promise.resolve(receipts.get(`${deploymentId}:${operation}:latest`)),
  clearLatestReceipt: (deploymentId: string, operation: string) => {
    receipts.delete(`${deploymentId}:${operation}:latest`);
    return Promise.resolve();
  },
}));

import {
  createOperationReceipt,
  dismissOperationReceipt,
  loadOperationReceipt,
  saveOperationReceipt,
  finishOperation,
  transactionExplorerUrl,
  tryBeginOperation,
} from "./operation-receipt";
import type { Deployment } from "./domain";

const deployment = {
  deploymentId: "09".repeat(32),
  network: "liquid-testnet",
  asset: { ticker: "RGA" },
} as Deployment;

describe("terminal operation receipts", () => {
  beforeEach(() => receipts.clear());

  it("persists a successful broadcast under its txid and restores it on revisit", async () => {
    const txid = "ab".repeat(32);
    const receipt = createOperationReceipt({
      deployment,
      operation: "transfer",
      txid,
      amount: "123",
      now: () => "2026-08-21T10:00:00.000Z",
    });
    await saveOperationReceipt(receipt);

    await expect(loadOperationReceipt(deployment.deploymentId, "transfer")).resolves.toEqual(receipt);
    expect(receipts.has(`${deployment.deploymentId}:transfer:${txid}`)).toBe(true);
  });

  it("requires an explicit new-operation action before the terminal receipt disappears", async () => {
    const receipt = createOperationReceipt({
      deployment,
      operation: "reissuance",
      txid: "cd".repeat(32),
      amount: "9",
    });
    await saveOperationReceipt(receipt);
    await dismissOperationReceipt(deployment.deploymentId, "reissuance");

    await expect(loadOperationReceipt(deployment.deploymentId, "reissuance")).resolves.toBeUndefined();
    expect(receipts.has(`${deployment.deploymentId}:reissuance:${receipt.txid}`)).toBe(true);
  });

  it("provides an external explorer only for Liquid testnet", () => {
    const txid = "ef".repeat(32);
    expect(transactionExplorerUrl("liquid-testnet", txid)).toContain(txid);
    expect(transactionExplorerUrl("elements-regtest", txid)).toBeUndefined();
  });

  it("blocks repeat clicks while signing and blocks all clicks after a terminal receipt", () => {
    const guard = { current: false };
    expect(tryBeginOperation(guard)).toBe(true);
    expect(tryBeginOperation(guard)).toBe(false);
    finishOperation(guard);
    const receipt = createOperationReceipt({
      deployment,
      operation: "transfer",
      txid: "aa".repeat(32),
      amount: "1",
    });
    expect(tryBeginOperation(guard, receipt)).toBe(false);
  });
});
