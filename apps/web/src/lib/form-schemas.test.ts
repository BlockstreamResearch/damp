import { describe, expect, it } from "vitest";

import { bootstrapRecoverySchema, displaySupplyToBaseUnits, reissueSchema, sendSchema, setupFormDefaults, setupSchema } from "./form-schemas";
import { maximumAssetBaseUnits, protocolId } from "./domain";

describe("workflow field validation", () => {
  it("returns setup errors on the exact fields that need correction", () => {
    const result = setupSchema.safeParse({ name: "", ticker: "", precision: 9, supply: "0", supplyMode: "fixed", network: "liquid-testnet" });
    expect(result.success).toBe(false);
    if (!result.success) expect(new Set(result.error.issues.map((issue) => issue.path[0]))).toEqual(new Set(["name", "ticker", "precision", "supply"]));
  });

  it("defaults new setup to the connected signer network", () => {
    expect(setupFormDefaults("elements-regtest").network).toBe("elements-regtest");
    expect(setupFormDefaults("liquid-testnet").network).toBe("liquid-testnet");
  });

  it("accepts only the current recovery format", () => {
    const recovery = {
      protocol: protocolId,
      name: "Audited asset",
      ticker: "AUDT",
      precision: 0,
      supply: "1000",
      supplyMode: "issuer-managed",
      network: "liquid-testnet",
      deploymentSalt: "11".repeat(32),
      policyAsset: "22".repeat(32),
      fundingAddresses: ["address-one-is-long-enough", "address-two-is-long-enough"],
    };
    expect(bootstrapRecoverySchema.safeParse(recovery).success).toBe(true);
    expect(bootstrapRecoverySchema.safeParse({ ...recovery, protocol: "unsupported-protocol" }).success).toBe(false);
  });

  it("converts the user-entered display supply to exact base units", () => {
    expect(displaySupplyToBaseUnits("500", 0)).toBe(500n);
    expect(displaySupplyToBaseUnits("500", 2)).toBe(50_000n);
    expect(displaySupplyToBaseUnits("1", 8)).toBe(100_000_000n);
  });

  it("rejects a display supply above the application amount cap", () => {
    expect(displaySupplyToBaseUnits(maximumAssetBaseUnits.toString(), 0)).toBe(maximumAssetBaseUnits);
    expect(() => displaySupplyToBaseUnits("184467440738", 8)).toThrow(/too large/i);
    expect(setupSchema.safeParse({ name: "Asset", ticker: "AST", precision: 8, supply: "184467440738", supplyMode: "fixed", network: "liquid-testnet" }).error?.issues[0]?.path).toEqual(["supply"]);
  });

  it("rejects zero/fractional reissuance base units with a useful field message", () => {
    expect(reissueSchema.safeParse({ amount: "0" }).error?.issues[0]?.message).toMatch(/positive whole number/);
    expect(reissueSchema.safeParse({ amount: "1.5" }).success).toBe(false);
  });

  it("validates send recipient and decimal amount independently", () => {
    const result = sendSchema.safeParse({ recipient: "", amount: "1,000" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.flatten().fieldErrors).toMatchObject({
      recipient: ["Paste the recipient's confidential DAMP address"],
      amount: ["Enter an amount greater than zero without signs or exponent notation"],
    });
    expect(sendSchema.safeParse({ recipient: "signed-record", amount: "3.00" }).success).toBe(true);
  });
});
