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
};

let modulePromise: Promise<SignerModule> | undefined;
let signer: WasmAmpSigner | undefined;
let state: SignerState = { connected: false };
const listeners = new Set<() => void>();

async function loadModule() {
  modulePromise ??= import("../generated/amp-signer/simplicity_amp_signer").then(async (module) => {
    await module.default();
    return module;
  });
  return modulePromise;
}

function publish(next: SignerState) {
  state = next;
  for (const listener of listeners) listener();
}

export function signerSnapshot() {
  return state;
}

export function subscribeSigner(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function connectSigner(mnemonic: string, network: SignerNetwork) {
  const words = mnemonic.trim().replace(/\s+/g, " ");
  if (!words) throw new Error("Enter a BIP39 recovery phrase.");
  const module = await loadModule();
  signer?.free();
  signer = new module.AmpSigner(words, network);
  const info = signer.info() as { fingerprint: string };
  publish({ connected: true, fingerprint: info.fingerprint, network });
  return info;
}

export function disconnectSigner() {
  signer?.free();
  signer = undefined;
  publish({ connected: false });
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

export async function deriveWalletAddress(
  branch: number,
  index: number,
  network?: SignerNetwork,
) {
  return requireSigner(network).deriveWalletAddress(branch, index) as DerivedWalletAddress;
}

export async function deriveAmpKey(deploymentSalt: string, role: "holder" | "issuer") {
  return requireSigner().deriveAmpKey(deploymentSalt, role) as {
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
  return requireSigner(input.network).bootstrap(input) as BootstrapResult;
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
  return requireSigner(input.deployment.network).signTransfer(input) as SignedOperation;
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
  return requireSigner(input.deployment.network).signPolicyUpdate(input) as SignedOperation;
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
  return requireSigner(input.deployment.network).reissue(input) as SignedOperation;
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
