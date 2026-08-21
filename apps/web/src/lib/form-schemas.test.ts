import { describe, expect, it } from "vitest";

import { reissueSchema, sendSchema, setupSchema } from "./form-schemas";

describe("workflow field validation", () => {
  it("returns setup errors on the exact fields that need correction", () => {
    const result = setupSchema.safeParse({ name: "", ticker: "", precision: 9, supply: "0", supplyMode: "fixed", network: "liquid-testnet" });
    expect(result.success).toBe(false);
    if (!result.success) expect(new Set(result.error.issues.map((issue) => issue.path[0]))).toEqual(new Set(["name", "ticker", "precision", "supply"]));
  });

  it("rejects zero/fractional reissuance base units with a useful field message", () => {
    expect(reissueSchema.safeParse({ amount: "0" }).error?.issues[0]?.message).toMatch(/positive whole number/);
    expect(reissueSchema.safeParse({ amount: "1.5" }).success).toBe(false);
  });

  it("validates send recipient and decimal amount independently", () => {
    const result = sendSchema.safeParse({ recipient: "", amount: "1,000" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().fieldErrors).toMatchObject({
      recipient: ["Paste a receive-record JSON or URL"],
      amount: ["Enter a positive decimal amount"],
    });
  });
});
