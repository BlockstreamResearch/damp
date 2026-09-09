import { z } from "zod";

/** Shared transport and minimal spent-state shape. Discovery owns its resource budget. */
export const esploraOutspendSchema = z.object({
  spent: z.boolean(),
  txid: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export class EsploraRequestError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`Esplora request failed (${status}) for ${url}.`);
    this.name = "EsploraRequestError";
  }
}

export async function getEsploraJson(
  request: typeof fetch,
  url: string,
  readResponse: (response: Response) => Promise<unknown> = (response) => response.json(),
): Promise<unknown> {
  const response = await request(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new EsploraRequestError(response.status, url);
  return readResponse(response);
}

export async function getEsploraText(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().replace(/[^\x20-\x7e]/g, " ").slice(0, 512);
    throw new Error(`Esplora request failed (${response.status}) for ${url}${detail ? `: ${detail}` : "."}`);
  }
  return text;
}
