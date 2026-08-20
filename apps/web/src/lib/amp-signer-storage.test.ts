import { beforeEach, describe, expect, it } from "vitest";

import { loadDebugMnemonic, saveDebugMnemonic } from "./amp-signer";

describe("debug signer persistence", () => {
  beforeEach(() => localStorage.clear());

  it("stores a normalized mnemonic in a versioned record", () => {
    saveDebugMnemonic("  abandon   ability  ");
    expect(loadDebugMnemonic()).toBe("abandon ability");
    expect(localStorage.getItem("simplicity-amp:debug-mnemonic:v1")).toBe(
      JSON.stringify({ version: 1, mnemonic: "abandon ability" }),
    );
  });

  it("ignores malformed or unknown records", () => {
    localStorage.setItem("simplicity-amp:debug-mnemonic:v1", JSON.stringify({ version: 2, mnemonic: "words" }));
    expect(loadDebugMnemonic()).toBeUndefined();
  });
});
