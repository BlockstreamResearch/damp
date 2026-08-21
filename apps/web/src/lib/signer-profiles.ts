import { z } from "zod";

import type { DeploymentManifest } from "./domain";

export type SignerProfileNetwork = DeploymentManifest["network"];

const fingerprintSchema = z.string().regex(/^[0-9a-f]{8}$/);
const publicIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/);
export const signerProfileIdSchema = z.string().regex(/^(liquid-testnet|elements-regtest):[0-9a-f]{64}$/);
const profileMetadataSchema = z.object({
  id: signerProfileIdSchema,
  publicIdentity: publicIdentitySchema,
  fingerprint: fingerprintSchema,
  network: z.enum(["liquid-testnet", "elements-regtest"]),
  label: z.string().trim().min(1).max(32),
}).strict();

const profileStoreSchema = z.object({
  version: z.literal(2),
  profiles: z.array(profileMetadataSchema).max(20),
}).strict();

export type SignerProfileMetadata = z.infer<typeof profileMetadataSchema>;
export type SignerProfile = SignerProfileMetadata & { unlocked: boolean; active: boolean };

export const signerProfilesStorageKey = "simplicity-amp:signer-profiles:v2";

export function signerProfileId(publicIdentity: string, network: SignerProfileNetwork) {
  return signerProfileIdSchema.parse(`${network}:${publicIdentitySchema.parse(publicIdentity)}`);
}

/**
 * Build the account identity from stable public wallet material. The BIP32
 * fingerprint remains a compact display hint only; it is intentionally not
 * part of this collision-resistant account key.
 */
export async function deriveSignerPublicIdentity(scriptPubkey: string, network: SignerProfileNetwork) {
  if (!/^(?:[0-9a-f]{2})+$/.test(scriptPubkey)) {
    throw new Error("Signer returned an invalid public wallet script.");
  }
  const domain = new TextEncoder().encode(`simplicity-amp/signer-profile/v1\0${network}\0`);
  const script = Uint8Array.from(scriptPubkey.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  const material = new Uint8Array(domain.byteLength + script.byteLength);
  material.set(domain);
  material.set(script, domain.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function defaultSignerProfileLabel(fingerprint: string) {
  return `Signer ${fingerprintSchema.parse(fingerprint)}`;
}

export function normalizeSignerProfileLabel(label: string) {
  const normalized = label.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Enter a profile label.");
  if (normalized.length > 32) throw new Error("Profile labels are limited to 32 characters.");
  return normalized;
}

export function loadSignerProfileMetadata(storage: Pick<Storage, "getItem"> = localStorage): SignerProfileMetadata[] {
  try {
    const raw = storage.getItem(signerProfilesStorageKey);
    if (!raw) return [];
    const parsed = profileStoreSchema.parse(JSON.parse(raw));
    const unique = new Map<string, SignerProfileMetadata>();
    for (const profile of parsed.profiles) {
      if (profile.id !== signerProfileId(profile.publicIdentity, profile.network)) continue;
      unique.set(profile.id, profile);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export function saveSignerProfileMetadata(
  profiles: SignerProfileMetadata[],
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  const validated = profiles.map((profile) => profileMetadataSchema.parse(profile));
  storage.setItem(signerProfilesStorageKey, JSON.stringify({ version: 2, profiles: validated }));
}

export function upsertSignerProfileMetadata(
  profiles: SignerProfileMetadata[],
  next: Omit<SignerProfileMetadata, "label"> & { label?: string },
) {
  const existing = profiles.find((profile) => profile.id === next.id);
  const profile = profileMetadataSchema.parse({
    ...next,
    label: next.label ? normalizeSignerProfileLabel(next.label) : existing?.label ?? defaultSignerProfileLabel(next.fingerprint),
  });
  return [...profiles.filter((candidate) => candidate.id !== profile.id), profile];
}

export function renameSignerProfileMetadata(
  profiles: SignerProfileMetadata[],
  id: string,
  label: string,
) {
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Unknown signer profile.");
  return profiles.map((profile) => profile.id === id
    ? profileMetadataSchema.parse({ ...profile, label: normalizeSignerProfileLabel(label) })
    : profile);
}

export function removeSignerProfileMetadata(profiles: SignerProfileMetadata[], id: string) {
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Unknown signer profile.");
  return profiles.filter((profile) => profile.id !== id);
}
