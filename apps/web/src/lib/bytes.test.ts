import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, sha256Hex } from "./bytes";

describe("byte encoding", () => {
  it("round-trips bytes including leading zeros and empty arrays", () => {
    expect(bytesToHex(hexToBytes("00017fff"))).toBe("00017fff");
    expect(bytesToHex(hexToBytes(""))).toBe("");
  });

  it.each(["0", "AB", "gg", "00 01"])("rejects noncanonical hex %s", (value) => {
    expect(() => hexToBytes(value)).toThrow("Expected lowercase hexadecimal bytes.");
  });

  it("hashes decoded bytes using the SHA-256 abc test vector", async () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("616263")).toBe(expected);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(expected);
    await expect(sha256Hex("")).rejects.toThrow("Expected lowercase hexadecimal bytes.");
  });
});
