import type {
  AmpSigner as WasmAmpSigner,
} from "../generated/amp-signer/simplicity_amp_signer";

import type {
  BlacklistEntry,
  DeploymentManifest,
  PolicySnapshot,
  ReceiveRecord,
  TreeDepth,
} from "./domain";
import {
  loadSignerProfileMetadata,
  deriveSignerPublicIdentity,
  removeSignerProfileMetadata,
  renameSignerProfileMetadata,
  saveSignerProfileMetadata,
  signerProfileId,
  upsertSignerProfileMetadata,
  type SignerProfile,
  type SignerProfileMetadata,
} from "./signer-profiles";
export type { SignerProfile } from "./signer-profiles";

type SignerModule = typeof import("../generated/amp-signer/simplicity_amp_signer");
export type SignerNetwork = DeploymentManifest["network"];

export type WalletKeyLocator = { branch: number; index: number };
export type HolderKeyLocator = { derivationIndex: number; ownerPublicKey: string };
export type SpendableUtxo = {
  txid: string;
  vout: number;
  transaction: string;
  spendable: boolean;
  walletKey?: WalletKeyLocator;
  holderKey?: HolderKeyLocator;
};

export type InspectedUtxo = {
  txid: string;
  vout: number;
  assetId: string;
  amount: string;
  scriptPubkey: string;
  assetConfidential: boolean;
  valueConfidential: boolean;
};

export type SignedOperation = {
  sdk: string;
  operation: "transfer" | "policy-update" | "reissuance";
  pset: string;
  transaction: string;
  txid: string;
  review: OperationReview;
};

export type OperationReview = {
  deploymentId: string;
  operation: string;
  regulatedAmount: string;
  fee: string;
  inputCount: number;
  outputCount: number;
  currentDepth: TreeDepth;
  successorDepth?: TreeDepth;
  recipients: string[];
};

export type BootstrapResult = {
  sdk: string;
  operation: "bootstrap";
  pset: string;
  transaction: string;
  txid: string;
  review: OperationReview;
  deployment: DeploymentManifest;
  deploymentId: string;
  initialPolicy: PolicySnapshot;
  initialReceiveRecord: ReceiveRecord;
  issuerDerivationIndex: number;
  holderDerivationIndex: number;
  requiredConfirmations: number;
};

export type CreatedReceiveRecord = {
  sdk: string;
  derivationIndex: number;
  record: ReceiveRecord;
};

export type DerivedWalletAddress = {
  sdk: string;
  branch: number;
  index: number;
  derivationPath: string;
  confidentialAddress: string;
  scriptPubkey: string;
};

export type SignerState = {
  connected: boolean;
  fingerprint?: string;
  network?: SignerNetwork;
  profileId?: string;
  walletReady: boolean;
  profiles: SignerProfile[];
};

let modulePromise: Promise<SignerModule> | undefined;
let signer: WasmAmpSigner | undefined;
const signerSessions = new Map<string, WasmAmpSigner>();
let rememberedProfiles: SignerProfileMetadata[] = loadSignerProfileMetadata();
let activeProfileId: string | undefined;
let state: SignerState = { connected: false, walletReady: false, profiles: profileSnapshot() };
let signerRevision = 0;
const listeners = new Set<() => void>();
const debugMnemonicKey = "simplicity-amp:debug-mnemonic:v1";

function normalizeMnemonic(mnemonic: string) {
  return mnemonic.trim().replace(/\s+/g, " ");
}

export function saveDebugMnemonic(mnemonic: string) {
  const normalized = normalizeMnemonic(mnemonic);
  if (!normalized) throw new Error("Cannot save an empty recovery phrase.");
  try {
    localStorage.setItem(debugMnemonicKey, JSON.stringify({ version: 1, mnemonic: normalized }));
  } catch {
    throw new Error("The generated recovery phrase could not be saved in local storage.");
  }
}

export function loadDebugMnemonic(): string | undefined {
  try {
    const stored = localStorage.getItem(debugMnemonicKey);
    if (!stored) return undefined;
    const parsed = JSON.parse(stored) as { version?: unknown; mnemonic?: unknown };
    if (parsed.version !== 1 || typeof parsed.mnemonic !== "string") return undefined;
    const normalized = normalizeMnemonic(parsed.mnemonic);
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

async function loadModule() {
  modulePromise ??= import("../generated/amp-signer/simplicity_amp_signer").then(async (module) => {
    await module.default();
    return module;
  });
  return modulePromise;
}

function profileSnapshot(): SignerProfile[] {
  return rememberedProfiles.map((profile) => ({
    ...profile,
    unlocked: signerSessions.has(profile.id),
    active: profile.id === activeProfileId,
  }));
}

function persistProfiles(profiles: SignerProfileMetadata[]) {
  try {
    saveSignerProfileMetadata(profiles);
  } catch {
    throw new Error("Signer profile metadata could not be saved in this browser.");
  }
}

function publish(next: Omit<SignerState, "profiles">, sessionChanged = true) {
  if (sessionChanged) signerRevision += 1;
  state = { ...next, profiles: profileSnapshot() };
  for (const listener of listeners) listener();
}

export function signerSnapshot() {
  return state;
}

export function signerSessionRevision() {
  return signerRevision;
}

export function subscribeSigner(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function connectSigner(
  mnemonic: string,
  network: SignerNetwork,
  options: { expectedProfileId?: string; label?: string } = {},
) {
  const words = normalizeMnemonic(mnemonic);
  if (!words) throw new Error("Enter a BIP39 recovery phrase.");
  const module = await loadModule();
  const candidate = new module.AmpSigner(words, network);
  let info: { fingerprint: string };
  try {
    info = candidate.info() as { fingerprint: string };
  } catch (error) {
    candidate.free();
    throw error;
  }
  let publicIdentity: string;
  try {
    const identityAddress = candidate.deriveWalletAddress(0, 0) as DerivedWalletAddress;
    publicIdentity = await deriveSignerPublicIdentity(identityAddress.scriptPubkey, network);
  } catch (error) {
    candidate.free();
    throw error;
  }
  const id = signerProfileId(publicIdentity, network);
  if (options.expectedProfileId && options.expectedProfileId !== id) {
    candidate.free();
    throw new Error("That recovery phrase does not unlock the selected signer profile.");
  }
  let nextProfiles: SignerProfileMetadata[];
  try {
    nextProfiles = upsertSignerProfileMetadata(rememberedProfiles, {
      id,
      publicIdentity,
      fingerprint: info.fingerprint,
      network,
      label: options.label,
    });
  } catch (error) {
    candidate.free();
    throw error;
  }
  const existingSession = signerSessions.get(id);
  if (existingSession) candidate.free();
  else signerSessions.set(id, candidate);
  try {
    persistProfiles(nextProfiles);
  } catch (error) {
    if (!existingSession) {
      signerSessions.delete(id);
      candidate.free();
    }
    throw error;
  }
  rememberedProfiles = nextProfiles;
  activeProfileId = id;
  signer = signerSessions.get(id);
  publish({ connected: true, fingerprint: info.fingerprint, network, profileId: id, walletReady: false });
  return info;
}

export function disconnectSigner() {
  for (const session of signerSessions.values()) session.free();
  signerSessions.clear();
  signer = undefined;
  activeProfileId = undefined;
  publish({ connected: false, walletReady: false });
}

export function switchSignerProfile(id: string, requiredNetwork?: SignerNetwork) {
  const profile = rememberedProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error("Unknown signer profile.");
  if (requiredNetwork && profile.network !== requiredNetwork) {
    throw new Error(`This deployment requires ${requiredNetwork}; the selected profile uses ${profile.network}.`);
  }
  const next = signerSessions.get(id);
  if (!next) throw new Error("That signer profile is locked. Enter its recovery phrase to unlock it.");
  if (activeProfileId === id && signer === next) return profile;
  activeProfileId = id;
  signer = next;
  publish({ connected: true, fingerprint: profile.fingerprint, network: profile.network, profileId: id, walletReady: false });
  return profile;
}

export function renameSignerProfile(id: string, label: string) {
  const nextProfiles = renameSignerProfileMetadata(rememberedProfiles, id, label);
  persistProfiles(nextProfiles);
  rememberedProfiles = nextProfiles;
  const { profiles: _profiles, ...current } = state;
  publish(current, false);
}

export function removeSignerProfile(id: string) {
  const nextProfiles = removeSignerProfileMetadata(rememberedProfiles, id);
  persistProfiles(nextProfiles);
  rememberedProfiles = nextProfiles;
  const removed = signerSessions.get(id);
  removed?.free();
  signerSessions.delete(id);
  if (activeProfileId === id) {
    activeProfileId = undefined;
    signer = undefined;
    publish({ connected: false, walletReady: false });
  } else {
    const { profiles: _profiles, ...current } = state;
    publish(current, false);
  }
}

export function markSignerWalletReady(profileId: string, network: SignerNetwork) {
  if (!state.connected || state.profileId !== profileId || state.network !== network || state.walletReady) return false;
  const { profiles: _profiles, ...current } = state;
  publish({ ...current, walletReady: true }, false);
  return true;
}

export async function generateMnemonic() {
  return (await loadModule()).generateMnemonic();
}

export function requireSigner(network?: SignerNetwork) {
  if (!signer) throw new Error("Connect the AMP signer first.");
  if (network && state.network !== network) {
    throw new Error(`Reconnect the AMP signer for ${network}.`);
  }
  return signer;
}

function requireReadySigner(network?: SignerNetwork) {
  const active = requireSigner(network);
  if (!state.walletReady) {
    throw new Error("Wait for this signer profile to finish a fresh wallet synchronization before signing.");
  }
  return active;
}

export async function deriveWalletAddress(
  branch: number,
  index: number,
  network?: SignerNetwork,
) {
  return requireSigner(network).deriveWalletAddress(branch, index) as DerivedWalletAddress;
}

export async function deriveAmpKey(
  deploymentSalt: string,
  role: "holder" | "issuer",
  network?: SignerNetwork,
) {
  return requireSigner(network).deriveAmpKey(deploymentSalt, role) as {
    sdk: string;
    derivationIndex: number;
    derivationPath: string;
    publicKey: string;
    role: string;
  };
}

export async function inspectUtxos(utxos: SpendableUtxo[]) {
  return requireSigner().inspectUtxos(utxos) as InspectedUtxo[];
}

export async function createReceiveRecord(
  deployment: DeploymentManifest,
  deploymentId: string,
  alias: string,
) {
  return requireSigner(deployment.network).createReceiveRecord({
    deployment,
    deploymentId,
    alias,
  }) as CreatedReceiveRecord;
}

export async function validateReceiveRecord(
  deployment: DeploymentManifest,
  record: ReceiveRecord,
) {
  requireSigner(deployment.network).validateReceiveRecord({ deployment, record });
}

export async function bootstrap(input: {
  network: SignerNetwork;
  policyAsset: string;
  deploymentSalt: string;
  asset: { name: string; ticker: string; precision: number };
  issuedSupply: string;
  supplyMode: "fixed" | "issuer-managed";
  policyUtxos: SpendableUtxo[];
  fee: string;
  requiredConfirmations: number;
  receiveAlias: string;
}) {
  return requireReadySigner(input.network).bootstrap(input) as BootstrapResult;
}

export async function signTransfer(input: {
  deployment: DeploymentManifest;
  currentPolicy: PolicySnapshot;
  verifierUtxo: SpendableUtxo;
  regulatedUtxos: SpendableUtxo[];
  feeUtxos: SpendableUtxo[];
  recipient: ReceiveRecord;
  amount: string;
  fee: string;
}) {
  return requireReadySigner(input.deployment.network).signTransfer(input) as SignedOperation;
}

export async function signPolicyUpdate(input: {
  deployment: DeploymentManifest;
  currentPolicy: PolicySnapshot;
  successorPolicy: PolicySnapshot;
  verifierUtxo: SpendableUtxo;
  feeUtxos: SpendableUtxo[];
  fee: string;
  issuerDerivationIndex: number;
}) {
  return requireReadySigner(input.deployment.network).signPolicyUpdate(input) as SignedOperation;
}

export async function reissue(input: {
  deployment: DeploymentManifest;
  currentPolicy: PolicySnapshot;
  verifierUtxo: SpendableUtxo;
  tokenUtxo: SpendableUtxo;
  feeUtxos: SpendableUtxo[];
  recipient: ReceiveRecord;
  amount: string;
  fee: string;
  issuerDerivationIndex: number;
}) {
  return requireReadySigner(input.deployment.network).reissue(input) as SignedOperation;
}

export async function buildBlacklist(entries: BlacklistEntry[], depth: TreeDepth) {
  return (await loadModule()).buildBlacklist(entries, depth) as {
    treeDepth: TreeDepth;
    policyRoot: string;
    setRoot: string;
    entryCount: number;
    entries: BlacklistEntry[];
  };
}

export async function preparePolicy(input: {
  deployment: DeploymentManifest;
  treeDepth: TreeDepth;
  setRoot: string;
  entryCount: number;
}) {
  return (await loadModule()).preparePolicy(input) as {
    sdk: string;
    policyRoot: string;
    verifierProgramHash: string;
    verifierScriptPubkey: string;
  };
}

export async function validateDeployment(deployment: DeploymentManifest) {
  return (await loadModule()).validateDeployment(deployment);
}

export async function validatePolicySnapshot(snapshot: PolicySnapshot) {
  return (await loadModule()).validatePolicySnapshot(snapshot);
}

export async function validateReceiveRecordShape(record: ReceiveRecord) {
  return (await loadModule()).validateReceiveRecordShape(record);
}
