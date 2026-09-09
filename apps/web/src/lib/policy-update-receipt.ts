import { z } from "zod";

import type { Deployment } from "./domain";
import { receiptStorage } from "./receipt-storage";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const outpoint = z.string().regex(/^[0-9a-f]{64}:[0-9]+$/);

export const policyUpdateReceiptSchema = z.object({
  schema: z.literal("simplicity-damp-policy-update-receipt-v1"),
  deploymentId: hash,
  signerProfileId: z.string().min(1),
  txid: hash,
  successorSequence: z.number().int().positive(),
  added: z.array(outpoint).max(64),
  removed: z.array(outpoint).max(64),
  createdAt: z.string().datetime(),
}).strict();

export type PolicyUpdateReceipt = z.infer<typeof policyUpdateReceiptSchema>;

export function createPolicyUpdateReceipt(input: {
  deployment: Deployment;
  signerProfileId: string;
  txid: string;
  successorSequence: number;
  added: string[];
  removed: string[];
  now?: () => string;
}): PolicyUpdateReceipt {
  return policyUpdateReceiptSchema.parse({
    schema: "simplicity-damp-policy-update-receipt-v1",
    deploymentId: input.deployment.deploymentId,
    signerProfileId: input.signerProfileId,
    txid: input.txid,
    successorSequence: input.successorSequence,
    added: input.added,
    removed: input.removed,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  });
}

export async function savePolicyUpdateReceipt(receipt: PolicyUpdateReceipt) {
  return storage.save(receipt);
}

export async function loadPolicyUpdateReceipt(deploymentId: string, signerProfileId: string) {
  return storage.load(deploymentId, "policy-update", signerProfileId);
}

export async function dismissPolicyUpdateReceipt(deploymentId: string, signerProfileId: string) {
  await storage.dismiss(deploymentId, "policy-update", signerProfileId);
}

const storage = receiptStorage(policyUpdateReceiptSchema, () => "policy-update");

export function policyUpdateReceiptQueryKey(deploymentId?: string, signerProfileId?: string) {
  return ["policy-update-receipt", deploymentId ?? "none", signerProfileId ?? "locked"] as const;
}
