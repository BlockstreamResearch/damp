import { z } from "zod";

import type { Deployment } from "./domain";
import { clearLatestReceipt, getLatestReceipt, putTxidKeyedReceipt } from "./store";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const outpoint = z.string().regex(/^[0-9a-f]{64}:[0-9]+$/);

export const policyUpdateReceiptSchema = z.object({
  schema: z.literal("simplicity-amp-policy-update-receipt-v1"),
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
    schema: "simplicity-amp-policy-update-receipt-v1",
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
  const validated = policyUpdateReceiptSchema.parse(receipt);
  await putTxidKeyedReceipt(validated.deploymentId, "policy-update", validated.signerProfileId, validated);
  return validated;
}

export async function loadPolicyUpdateReceipt(deploymentId: string, signerProfileId: string) {
  const stored = await getLatestReceipt<unknown>(deploymentId, "policy-update", signerProfileId);
  return stored === undefined ? undefined : policyUpdateReceiptSchema.parse(stored);
}

export async function dismissPolicyUpdateReceipt(deploymentId: string, signerProfileId: string) {
  await clearLatestReceipt(deploymentId, "policy-update", signerProfileId);
}

export function policyUpdateReceiptQueryKey(deploymentId?: string, signerProfileId?: string) {
  return ["policy-update-receipt", deploymentId ?? "none", signerProfileId ?? "locked"] as const;
}

