/** Hex strings represent bytes, not UTF-8 text. Digests use display byte order. */
export function hexToBytes(hex: string) {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("Expected lowercase hexadecimal bytes.");
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function bytesToHex(bytes: ArrayLike<number>) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string | Uint8Array<ArrayBuffer>) {
  if (value === "") throw new Error("Expected lowercase hexadecimal bytes.");
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
