import { beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.hoisted(() => vi.fn());

vi.mock("../generated/amp-signer/simplicity_amp_signer", () => ({
  default: init,
  generateMnemonic: vi.fn(() => "generated words"),
}));

describe("LWK signer module initialization", () => {
  beforeEach(() => {
    init.mockReset();
    vi.resetModules();
  });

  it("reports initialization failures with context and allows a later retry", async () => {
    init.mockRejectedValueOnce(new Error("WASM asset unavailable"));
    const signer = await import("./amp-signer");

    await expect(signer.generateMnemonic()).rejects.toThrow(
      "The LWK signer module could not be initialized: WASM asset unavailable",
    );

    init.mockResolvedValueOnce(undefined);
    await expect(signer.generateMnemonic()).resolves.toBe("generated words");
    expect(init).toHaveBeenCalledTimes(2);
  });
});
