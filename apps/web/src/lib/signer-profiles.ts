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
const debugSignerProfileSchema = profileMetadataSchema.extend({
  // Deliberately unencrypted and test-only. These profiles must never be used
  // for mainnet or production custody.
  debugMnemonic: z.string().min(1).max(512).refine(
    (value) => value === normalizeDebugSignerMnemonic(value),
    "Debug signer recovery phrases must be normalized.",
  ),
}).strict();
const debugProfileStoreSchema = z.object({
  version: z.literal(1),
  profiles: z.array(debugSignerProfileSchema).max(20),
}).strict();

export type SignerProfileMetadata = z.infer<typeof profileMetadataSchema>;
export type StoredDebugSignerProfile = z.infer<typeof debugSignerProfileSchema>;
export type SignerProfile = SignerProfileMetadata & { active: boolean };

export const debugSignerProfilesStorageKey = "simplicity-amp:debug-signer-profiles:v1";

export function normalizeDebugSignerMnemonic(mnemonic: string) {
  return mnemonic.trim().replace(/\s+/g, " ");
}

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

export function loadDebugSignerProfiles(
  storage: Pick<Storage, "getItem"> = localStorage,
): StoredDebugSignerProfile[] {
  try {
    const raw = storage.getItem(debugSignerProfilesStorageKey);
    if (!raw) return [];
    const parsed = debugProfileStoreSchema.parse(JSON.parse(raw));
    if (new Set(parsed.profiles.map((profile) => profile.id)).size !== parsed.profiles.length) return [];
    if (parsed.profiles.some((profile) => profile.id !== signerProfileId(profile.publicIdentity, profile.network))) return [];
    return parsed.profiles;
  } catch {
    return [];
  }
}

export function saveDebugSignerProfiles(
  profiles: StoredDebugSignerProfile[],
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  const store = debugProfileStoreSchema.parse({ version: 1, profiles });
  if (new Set(store.profiles.map((profile) => profile.id)).size !== store.profiles.length) {
    throw new Error("Duplicate debug signer profile identity.");
  }
  storage.setItem(debugSignerProfilesStorageKey, JSON.stringify(store));
}

export function upsertDebugSignerProfile(
  profiles: StoredDebugSignerProfile[],
  next: Omit<StoredDebugSignerProfile, "label"> & { label?: string },
) {
  const existing = profiles.find((profile) => profile.id === next.id);
  const profile = debugSignerProfileSchema.parse({
    ...next,
    debugMnemonic: normalizeDebugSignerMnemonic(next.debugMnemonic),
    label: next.label ? normalizeSignerProfileLabel(next.label) : existing?.label ?? defaultSignerProfileLabel(next.fingerprint),
  });
  return [...profiles.filter((candidate) => candidate.id !== profile.id), profile];
}

export function renameDebugSignerProfile(
  profiles: StoredDebugSignerProfile[],
  id: string,
  label: string,
) {
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Unknown signer profile.");
  return profiles.map((profile) => profile.id === id
    ? debugSignerProfileSchema.parse({ ...profile, label: normalizeSignerProfileLabel(label) })
    : profile);
}

export function removeDebugSignerProfile(profiles: StoredDebugSignerProfile[], id: string) {
  if (!profiles.some((profile) => profile.id === id)) throw new Error("Unknown signer profile.");
  return profiles.filter((profile) => profile.id !== id);
}
