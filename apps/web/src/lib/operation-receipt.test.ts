import { beforeEach, describe, expect, it, vi } from "vitest";

const receipts = vi.hoisted(() => new Map<string, unknown>());

vi.mock("./store", () => ({
  putTxidKeyedReceipt: (deploymentId: string, operation: string, fingerprint: string, receipt: { txid: string }) => {
    receipts.set(`${deploymentId}:${operation}:${fingerprint}:${receipt.txid}`, structuredClone(receipt));
    receipts.set(`${deploymentId}:${operation}:${fingerprint}:latest`, structuredClone(receipt));
    return Promise.resolve();
  },
  getLatestReceipt: (deploymentId: string, operation: string, fingerprint: string) => Promise.resolve(receipts.get(`${deploymentId}:${operation}:${fingerprint}:latest`)),
  clearLatestReceipt: (deploymentId: string, operation: string, fingerprint: string) => {
    receipts.delete(`${deploymentId}:${operation}:${fingerprint}:latest`);
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
const signerProfileId = `liquid-testnet:${"aa".repeat(32)}`;

describe("terminal operation receipts", () => {
  beforeEach(() => receipts.clear());

  it("persists a successful broadcast under its txid and restores it on revisit", async () => {
    const txid = "ab".repeat(32);
    const receipt = createOperationReceipt({
      deployment,
      operation: "transfer",
      txid,
      amount: "123",
      signerProfileId,
      now: () => "2026-08-21T10:00:00.000Z",
    });
    await saveOperationReceipt(receipt);

    await expect(loadOperationReceipt(deployment.deploymentId, "transfer", signerProfileId)).resolves.toEqual(receipt);
    expect(receipts.has(`${deployment.deploymentId}:transfer:${signerProfileId}:${txid}`)).toBe(true);
  });

  it("requires an explicit new-operation action before the terminal receipt disappears", async () => {
    const receipt = createOperationReceipt({
      deployment,
      operation: "reissuance",
      txid: "cd".repeat(32),
      amount: "9",
      signerProfileId,
    });
    await saveOperationReceipt(receipt);
    await dismissOperationReceipt(deployment.deploymentId, "reissuance", signerProfileId);

    await expect(loadOperationReceipt(deployment.deploymentId, "reissuance", signerProfileId)).resolves.toBeUndefined();
    expect(receipts.has(`${deployment.deploymentId}:reissuance:${signerProfileId}:${receipt.txid}`)).toBe(true);
  });

  it("never restores signer A's terminal operation under signer B", async () => {
    const receipt = createOperationReceipt({ deployment, operation: "transfer", txid: "de".repeat(32), amount: "4", signerProfileId });
    await saveOperationReceipt(receipt);
    await expect(loadOperationReceipt(deployment.deploymentId, "transfer", `liquid-testnet:${"bb".repeat(32)}`)).resolves.toBeUndefined();
    await expect(loadOperationReceipt(deployment.deploymentId, "transfer", signerProfileId)).resolves.toEqual(receipt);
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
      signerProfileId,
    });
    expect(tryBeginOperation(guard, receipt)).toBe(false);
  });
});
