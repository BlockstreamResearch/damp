import { z } from "zod";

import type { Deployment } from "./domain";
import { clearLatestReceipt, getLatestReceipt, putTxidKeyedReceipt } from "./store";

const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const operationReceiptSchema = z.object({
  schema: z.literal("simplicity-amp-operation-receipt-v3"),
  deploymentId: hash,
  signerProfileId: z.string().regex(/^(liquid-testnet|elements-regtest):[0-9a-f]{64}$/),
  operation: z.enum(["transfer", "reissuance"]),
  txid: hash,
  amount: z.string().regex(/^[1-9][0-9]*$/),
  ticker: z.string().trim().min(1).max(12),
  createdAt: z.string().datetime(),
}).strict();

export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
export type ReceiptOperation = OperationReceipt["operation"];
export type OperationExecutionGuard = { current: boolean };

export function tryBeginOperation(guard: OperationExecutionGuard, receipt?: OperationReceipt | null) {
  if (guard.current || receipt) return false;
  guard.current = true;
  return true;
}

export function finishOperation(guard: OperationExecutionGuard) {
  guard.current = false;
}

export function createOperationReceipt(input: {
  deployment: Deployment;
  operation: ReceiptOperation;
  txid: string;
  amount: string;
  signerProfileId: string;
  now?: () => string;
}) {
  return operationReceiptSchema.parse({
    schema: "simplicity-amp-operation-receipt-v3",
    deploymentId: input.deployment.deploymentId,
    signerProfileId: input.signerProfileId,
    operation: input.operation,
    txid: input.txid,
    amount: input.amount,
    ticker: input.deployment.asset.ticker,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  });
}

export async function saveOperationReceipt(receipt: OperationReceipt) {
  const validated = operationReceiptSchema.parse(receipt);
  await putTxidKeyedReceipt(validated.deploymentId, validated.operation, validated.signerProfileId, validated);
  return validated;
}

export async function loadOperationReceipt(deploymentId: string, operation: ReceiptOperation, signerProfileId: string) {
  const stored = await getLatestReceipt<unknown>(deploymentId, operation, signerProfileId);
  return stored === undefined ? undefined : operationReceiptSchema.parse(stored);
}

export async function dismissOperationReceipt(deploymentId: string, operation: ReceiptOperation, signerProfileId: string) {
  await clearLatestReceipt(deploymentId, operation, signerProfileId);
}

export function operationReceiptQueryKey(deploymentId: string | undefined, operation: ReceiptOperation, signerProfileId?: string) {
  return ["operation-receipt", deploymentId ?? "none", operation, signerProfileId ?? "locked"] as const;
}

export function transactionExplorerUrl(network: Deployment["network"], txid: string) {
  return network === "liquid-testnet"
    ? `https://blockstream.info/liquidtestnet/tx/${txid}`
    : undefined;
}
