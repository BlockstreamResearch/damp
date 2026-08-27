import type {
  AmpSigner as WasmAmpSigner,
} from "../generated/amp-signer/simplicity_amp_signer";

import type {
  BlacklistEntry,
  DeploymentManifest,
  PolicySnapshot,
  TreeDepth,
} from "./domain";
import {
  deriveSignerPublicIdentity,
  loadDebugSignerProfiles,
  normalizeDebugSignerMnemonic,
  removeDebugSignerProfile,
  renameDebugSignerProfile,
  saveDebugSignerProfiles,
  signerProfileId,
  upsertDebugSignerProfile,
  type SignerProfile,
  type StoredDebugSignerProfile,
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
  initialHolderAddress: DerivedHolderAddress;
  issuerDerivationIndex: number;
  holderDerivationIndex: number;
  requiredConfirmations: number;
};

export type SplitFundingResult = {
  sdk: string;
  operation: "funding-split";
  pset: string;
  transaction: string;
  txid: string;
  sourceTxid: string;
  sourceVout: number;
  sourceAmount: string;
  fee: string;
  outputs: Array<{
    vout: number;
    amount: string;
    confidentialAddress: string;
    walletKey: WalletKeyLocator;
  }>;
};

export type DerivedHolderAddress = {
  sdk: string;
  derivationIndex: number;
  ownerPublicKey: string;
  scriptPubkey: string;
  confidentialAddress: string;
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
let debugProfiles: StoredDebugSignerProfile[] = loadDebugSignerProfiles();
let activeProfileId: string | undefined;
let state: SignerState = { connected: false, walletReady: false, profiles: profileSnapshot() };
let signerRevision = 0;
let activationRevision = 0;
const listeners = new Set<() => void>();

async function loadModule() {
  modulePromise ??= import("../generated/amp-signer/simplicity_amp_signer")
    .then(async (module) => {
      await module.default();
      return module;
    })
    .catch((error: unknown) => {
      // A transient asset/network failure must not poison every later signer attempt in this tab.
      // Clearing the rejected promise lets an explicit retry load a fresh WASM module instance.
      modulePromise = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The LWK signer module could not be initialized: ${reason}`);
    });
  return modulePromise;
}

function profileSnapshot(): SignerProfile[] {
  return debugProfiles.map((profile) => ({
    id: profile.id,
    publicIdentity: profile.publicIdentity,
    fingerprint: profile.fingerprint,
    network: profile.network,
    label: profile.label,
    active: profile.id === activeProfileId,
  }));
}

function persistProfiles(profiles: StoredDebugSignerProfile[]) {
  try {
    saveDebugSignerProfiles(profiles);
  } catch {
    throw new Error("The test-only debug signer profiles could not be saved in this browser.");
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

async function createDebugSignerCandidate(mnemonic: string, network: SignerNetwork) {
  const words = normalizeDebugSignerMnemonic(mnemonic);
  if (!words) throw new Error("Enter a BIP39 recovery phrase.");
  const module = await loadModule();
  const candidate = new module.AmpSigner(words, network);
  let info: { fingerprint: string };
  try {
    info = candidate.info() as { fingerprint: string };
    const identityAddress = candidate.deriveWalletAddress(0, 0) as DerivedWalletAddress;
    const publicIdentity = await deriveSignerPublicIdentity(identityAddress.scriptPubkey, network);
    return {
      candidate,
      debugMnemonic: words,
      id: signerProfileId(publicIdentity, network),
      info,
      publicIdentity,
    };
  } catch (error) {
    candidate.free();
    throw error;
  }
}

export async function connectSigner(
  mnemonic: string,
  network: SignerNetwork,
  options: { label?: string } = {},
) {
  const request = ++activationRevision;
  const created = await createDebugSignerCandidate(mnemonic, network);
  const { candidate, debugMnemonic, id, info, publicIdentity } = created;
  if (request !== activationRevision) {
    candidate.free();
    throw new Error("Another signer profile selection replaced this request.");
  }
  let nextProfiles: StoredDebugSignerProfile[];
  try {
    nextProfiles = upsertDebugSignerProfile(debugProfiles, {
      id,
      publicIdentity,
      fingerprint: info.fingerprint,
      network,
      label: options.label,
      debugMnemonic,
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
  debugProfiles = nextProfiles;
  activeProfileId = id;
  signer = signerSessions.get(id);
  publish({ connected: true, fingerprint: info.fingerprint, network, profileId: id, walletReady: false });
  return info;
}

export function disconnectSigner() {
  activationRevision += 1;
  for (const session of signerSessions.values()) session.free();
  signerSessions.clear();
  signer = undefined;
  activeProfileId = undefined;
  publish({ connected: false, walletReady: false });
}

export async function switchSignerProfile(id: string, requiredNetwork?: SignerNetwork) {
  const request = ++activationRevision;
  const profile = debugProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error("Unknown signer profile.");
  if (requiredNetwork && profile.network !== requiredNetwork) {
    throw new Error(`This deployment requires ${requiredNetwork}; the selected profile uses ${profile.network}.`);
  }
  let next = signerSessions.get(id);
  if (!next) {
    const restored = await createDebugSignerCandidate(profile.debugMnemonic, profile.network);
    if (request !== activationRevision) {
      restored.candidate.free();
      throw new Error("Another signer profile selection replaced this request.");
    }
    if (
      restored.id !== profile.id
      || restored.publicIdentity !== profile.publicIdentity
      || restored.info.fingerprint !== profile.fingerprint
    ) {
      restored.candidate.free();
      throw new Error("Stored debug signer material does not match its profile identity.");
    }
    signerSessions.set(id, restored.candidate);
    next = restored.candidate;
  }
  if (activeProfileId === id && signer === next) return profile;
  activeProfileId = id;
  signer = next;
  publish({ connected: true, fingerprint: profile.fingerprint, network: profile.network, profileId: id, walletReady: false });
  return profile;
}

export function renameSignerProfile(id: string, label: string) {
  const nextProfiles = renameDebugSignerProfile(debugProfiles, id, label);
  persistProfiles(nextProfiles);
  debugProfiles = nextProfiles;
  const { profiles: _profiles, ...current } = state;
  publish(current, false);
}

export function removeSignerProfile(id: string) {
  activationRevision += 1;
  const nextProfiles = removeDebugSignerProfile(debugProfiles, id);
  persistProfiles(nextProfiles);
  debugProfiles = nextProfiles;
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
  if (!signer) throw new Error("Connect the DAMP signer first.");
  if (network && state.network !== network) {
    throw new Error(`Reconnect the DAMP signer for ${network}.`);
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

export async function deriveHolderAddress(deployment: DeploymentManifest) {
  return requireSigner(deployment.network).deriveHolderAddress(deployment) as DerivedHolderAddress;
}

export async function validateRecipientAddress(deployment: DeploymentManifest, address: string) {
  return requireSigner(deployment.network).validateRecipientAddress(deployment, address) as string;
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
}) {
  return requireReadySigner(input.network).bootstrap(input) as BootstrapResult;
}

export async function splitFunding(input: {
  network: SignerNetwork;
  policyAsset: string;
  sourceUtxos: SpendableUtxo[];
  fee: string;
}) {
  return requireReadySigner(input.network).splitFunding(input) as SplitFundingResult;
}

export async function signTransfer(input: {
  deployment: DeploymentManifest;
  currentPolicy: PolicySnapshot;
  verifierUtxo: SpendableUtxo;
  regulatedUtxos: SpendableUtxo[];
  feeUtxos: SpendableUtxo[];
  recipientAddress: string;
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
  recipientAddress: string;
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
