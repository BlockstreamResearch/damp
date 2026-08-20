import { z } from "zod";

export const HASH = /^[0-9a-f]{64}$/;
export const SCRIPT = /^(?:[0-9a-f]{2})+$/;
export const OUTPOINT = /^[0-9a-f]{64}:[0-9]+$/;
export const registrySchema = "simplicity-amp-registry-v1" as const;
export const protocolId = "simplicity-amp/v0.1" as const;
export const supportedTreeDepths = [4, 5, 6] as const;

const hash = z.string().regex(HASH);

export const assetMetadataSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ticker: z.string().trim().min(1).max(12),
  precision: z.number().int().min(0).max(8),
}).strict();

export const deploymentManifestSchema = z.object({
  schema: z.literal(registrySchema),
  protocol: z.literal(protocolId),
  network: z.enum(["liquid-testnet", "elements-regtest"]),
  policyAsset: hash,
  regulatedAsset: hash,
  verifierAsset: hash,
  verifierAssetAmount: z.literal(1),
  issuerPublicKey: hash,
  deploymentSalt: hash,
  genesisAnchor: z.string().regex(OUTPOINT),
  asset: assetMetadataSchema,
  issuedSupply: z.string().regex(/^[1-9][0-9]*$/),
  supplyMode: z.enum(["fixed", "issuer-managed"]),
  reissuanceToken: hash.nullable(),
  reissuanceEntropy: hash.nullable(),
  userProgramHash: hash,
  governanceProgramHash: hash,
  contractBundleHash: hash,
}).strict().superRefine((deployment, context) => {
  if (new Set([deployment.policyAsset, deployment.regulatedAsset, deployment.verifierAsset]).size !== 3) {
    context.addIssue({
      code: "custom",
      message: "Policy, regulated, and verifier assets must be distinct.",
    });
  }
  const managed = deployment.supplyMode === "issuer-managed";
  if (managed !== (deployment.reissuanceToken !== null && deployment.reissuanceEntropy !== null)) {
    context.addIssue({
      code: "custom",
      message: "Reissuance token and entropy must exist exactly for issuer-managed supply.",
    });
  }
});

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;

export const localDeploymentSchema = deploymentManifestSchema.extend({
  deploymentId: hash,
  confirmations: z.number().int().nonnegative().default(0),
  activeAnchor: z.string().regex(OUTPOINT).optional(),
  issuerDerivationIndex: z.number().int().min(0).max(0x7fff_ffff).optional(),
  publication: z.enum(["local", "pending", "published"]),
}).strict();

export type Deployment = z.infer<typeof localDeploymentSchema>;

export function requireDeployment(deployment: Deployment | undefined): Deployment {
  if (!deployment) throw new Error("Import or create a deployment first.");
  return deployment;
}

export function requirePublishedDeployment(deployment: Deployment | undefined): Deployment {
  const selected = requireDeployment(deployment);
  if (selected.publication !== "published") {
    throw new Error("The deployment manifest and initial policy must be published before asset operations.");
  }
  return selected;
}

export function publicManifest(deployment: Deployment): DeploymentManifest {
  const { deploymentId: _deploymentId, confirmations: _confirmations, activeAnchor: _activeAnchor,
    issuerDerivationIndex: _issuerDerivationIndex, publication: _publication, ...manifest } = deployment;
  return deploymentManifestSchema.parse(manifest);
}

export const blacklistEntrySchema = z.object({
  txid: hash,
  vout: z.number().int().min(0).max(0xffff_ffff),
  note: z.string().trim().max(280).optional(),
}).strict();

export type BlacklistEntry = z.infer<typeof blacklistEntrySchema>;

export const treeDepthSchema = z.union([z.literal(4), z.literal(5), z.literal(6)]);
export type TreeDepth = z.infer<typeof treeDepthSchema>;

export const policySnapshotSchema = z.object({
  schema: z.literal(registrySchema),
  protocol: z.literal(protocolId),
  deploymentId: hash,
  sequence: z.number().int().nonnegative(),
  parentPolicyRoot: hash.nullable(),
  parentVerifierScriptHash: hash.nullable(),
  treeDepth: treeDepthSchema,
  setRoot: hash,
  entryCount: z.number().int().min(0).max(64),
  policyRoot: hash,
  verifierProgramHash: hash,
  verifierScriptPubkey: z.string().regex(SCRIPT),
  entries: z.array(blacklistEntrySchema).max(64),
}).strict().superRefine((snapshot, context) => {
  const genesis = snapshot.sequence === 0;
  if (genesis !== (snapshot.parentPolicyRoot === null && snapshot.parentVerifierScriptHash === null)) {
    context.addIssue({ code: "custom", message: "Policy parent fields must be null only at sequence zero." });
  }
  if (snapshot.entryCount !== snapshot.entries.length) {
    context.addIssue({ code: "custom", message: "Policy entry count does not match entries." });
  }
  if (snapshot.entries.length > 2 ** snapshot.treeDepth) {
    context.addIssue({ code: "custom", message: "Policy exceeds the selected tree capacity." });
  }
});

export type PolicySnapshot = z.infer<typeof policySnapshotSchema>;

export const receiveRecordSchema = z.object({
  schema: z.literal(registrySchema),
  protocol: z.literal(protocolId),
  deploymentId: hash,
  alias: z.string().trim().min(1).max(80),
  ownerPublicKey: hash,
  scriptPubkey: z.string().regex(SCRIPT),
  confidentialAddress: z.string().min(20),
  blindingPublicKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/),
  proofAddress: z.string().min(20),
  bip322Signature: z.string().min(1),
}).strict();

export type ReceiveRecord = z.infer<typeof receiveRecordSchema>;

export function smallestTreeDepth(entryCount: number): TreeDepth {
  const depth = supportedTreeDepths.find((candidate) => entryCount <= 2 ** candidate);
  if (!depth) throw new Error("AMP v0.1 supports at most 64 blacklist entries.");
  return depth;
}

export function shortHash(value: string, start = 8, end = 6) {
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

export function formatUnits(amount: bigint | string, precision: number) {
  const value = typeof amount === "string" ? BigInt(amount) : amount;
  const scale = 10n ** BigInt(precision);
  const whole = value / scale;
  const fractional = (value % scale).toString().padStart(precision, "0").replace(/0+$/, "");
  return fractional ? `${whole.toLocaleString()}.${fractional}` : whole.toLocaleString();
}

export function parseUnits(value: string, precision: number): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value.trim());
  if (!match) throw new Error("Amount must be a non-negative decimal without separators.");
  const fractional = match[2] ?? "";
  if (fractional.length > precision) throw new Error(`Amount supports at most ${precision} decimals.`);
  return BigInt(match[1]) * 10n ** BigInt(precision) + BigInt(fractional.padEnd(precision, "0") || "0");
}
