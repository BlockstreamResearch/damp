import { beforeEach, describe, expect, it, vi } from "vitest";

const receipts = vi.hoisted(() => new Map<string, unknown>());

vi.mock("./store", () => ({
  putTxidKeyedReceipt: (deploymentId: string, operation: string, signerProfileId: string, receipt: { txid: string }) => {
    receipts.set(`${deploymentId}:${operation}:${signerProfileId}:${receipt.txid}`, structuredClone(receipt));
    receipts.set(`${deploymentId}:${operation}:${signerProfileId}:latest`, structuredClone(receipt));
    return Promise.resolve();
  },
  getLatestReceipt: (deploymentId: string, operation: string, signerProfileId: string) => Promise.resolve(receipts.get(`${deploymentId}:${operation}:${signerProfileId}:latest`)),
  clearLatestReceipt: (deploymentId: string, operation: string, signerProfileId: string) => {
    receipts.delete(`${deploymentId}:${operation}:${signerProfileId}:latest`);
    return Promise.resolve();
  },
}));

import type { Deployment } from "./domain";
import {
  createPolicyUpdateReceipt,
  dismissPolicyUpdateReceipt,
  loadPolicyUpdateReceipt,
  savePolicyUpdateReceipt,
} from "./policy-update-receipt";

describe("policy update receipt", () => {
  beforeEach(() => receipts.clear());

  it("captures and durably restores the exact broadcast transaction and policy diff", async () => {
    const deployment = { deploymentId: "aa".repeat(32) } as Deployment;
    const added = `${"bb".repeat(32)}:1`;
    const removed = `${"cc".repeat(32)}:2`;
    const receipt = createPolicyUpdateReceipt({
      deployment,
      signerProfileId: `liquid-testnet:${"dd".repeat(32)}`,
      txid: "ee".repeat(32),
      successorSequence: 2,
      added: [added],
      removed: [removed],
      now: () => "2026-08-25T10:00:00.000Z",
    });

    expect(receipt).toMatchObject({ added: [added], removed: [removed], successorSequence: 2 });
    await savePolicyUpdateReceipt(receipt);
    await expect(loadPolicyUpdateReceipt(deployment.deploymentId, receipt.signerProfileId)).resolves.toEqual(receipt);
    await dismissPolicyUpdateReceipt(deployment.deploymentId, receipt.signerProfileId);
    await expect(loadPolicyUpdateReceipt(deployment.deploymentId, receipt.signerProfileId)).resolves.toBeUndefined();
  });
});
