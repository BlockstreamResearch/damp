import { z } from "zod";

export const setupSchema = z.object({
  name: z.string().trim().min(1, "Enter an asset name").max(80),
  ticker: z.string().trim().min(1, "Enter an asset ticker").max(12),
  precision: z.number().int("Precision must be a whole number").min(0).max(8),
  supply: z.string().regex(/^[1-9][0-9]*$/, "Enter a positive whole-number supply"),
  supplyMode: z.enum(["fixed", "issuer-managed"]),
  network: z.enum(["liquid-testnet", "elements-regtest"]),
});

export const reissueSchema = z.object({
  amount: z.string().regex(/^[1-9][0-9]*$/, "Enter a positive whole number of base units"),
});

export const sendSchema = z.object({
  recipient: z.string().trim().min(1, "Paste a receive-record JSON or URL"),
  amount: z.string().trim().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, "Enter a positive decimal amount"),
});

export type SetupForm = z.infer<typeof setupSchema>;
export type ReissueForm = z.infer<typeof reissueSchema>;
export type SendForm = z.infer<typeof sendSchema>;
