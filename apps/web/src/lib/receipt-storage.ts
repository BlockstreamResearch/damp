import type { z } from "zod";
import { clearLatestReceipt, getLatestReceipt, putTxidKeyedReceipt } from "./store";

type StoredReceipt = { deploymentId: string; signerProfileId: string; txid: string };

/** Validate before persistence and after loading; preserve the existing IndexedDB keys. */
export function receiptStorage<T extends StoredReceipt>(schema: z.ZodType<T>, operation: (receipt: T) => string) {
  return {
    async save(receipt: T) {
      const validated = schema.parse(receipt);
      await putTxidKeyedReceipt(validated.deploymentId, operation(validated), validated.signerProfileId, validated);
      return validated;
    },
    async load(deploymentId: string, kind: string, signerProfileId: string) {
      const stored = await getLatestReceipt<unknown>(deploymentId, kind, signerProfileId);
      return stored === undefined ? undefined : schema.parse(stored);
    },
    async dismiss(deploymentId: string, kind: string, signerProfileId: string) {
      await clearLatestReceipt(deploymentId, kind, signerProfileId);
    },
  };
}
