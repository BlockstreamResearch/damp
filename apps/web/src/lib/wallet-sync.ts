import { z } from "zod";

import {
  createReceiveRecord,
  deriveWalletAddress,
  inspectUtxos,
  signerSessionRevision,
  signerSnapshot,
  validateReceiveRecord,
  validateReceiveRecordShape,
  type DerivedWalletAddress,
  type InspectedUtxo,
  type SignerNetwork,
  type SpendableUtxo,
} from "./amp-signer";
import {
  HASH,
  SCRIPT,
  publicManifest,
  receiveRecordSchema,
  type Deployment,
} from "./domain";
import { esploraUrlForDeployment } from "./esplora";
import {
  getWalletSyncRecord,
  listReceiveRecords,
  putReceiveRecord,
  putWalletSyncRecord,
  type StoredReceiveRecord,
} from "./store";

export const walletSyncVersion = 1 as const;
export const defaultWalletGapLimit = 10;
const maxDiscoveryIndex = 999;
const maxDiscoveredUtxos = 1_000;
const maxJsonResponseBytes = 1_000_000;
const maxTransactionHexBytes = 2_000_000;
const transactionFetchConcurrency = 8;
const OUTPOINT = /^[0-9a-f]{64}:[0-9]+$/;
const AMOUNT = /^(0|[1-9][0-9]*)$/;
const TRANSACTION_HEX = /^(?:[0-9a-f]{2})+$/;

const walletAddressSchema = z.object({
  source: z.literal("wallet"),
  branch: z.union([z.literal(0), z.literal(1)]),
  index: z.number().int().min(0).max(0x7fff_ffff),
  confidentialAddress: z.string().min(20),
  scriptPubkey: z.string().regex(SCRIPT),
  hasActivity: z.boolean(),
}).strict();

const holderAddressSchema = z.object({
  source: z.literal("holder"),
  derivationIndex: z.number().int().min(0).max(0x7fff_ffff),
  ownerPublicKey: z.string().regex(HASH),
  confidentialAddress: z.string().min(20),
  scriptPubkey: z.string().regex(SCRIPT),
  hasActivity: z.boolean(),
}).strict();

export const walletSyncAddressSchema = z.discriminatedUnion("source", [walletAddressSchema, holderAddressSchema]);
export type WalletSyncAddress = z.infer<typeof walletSyncAddressSchema>;

const syncedUtxoBaseSchema = z.object({
  txid: z.string().regex(HASH),
  vout: z.number().int().nonnegative(),
  transaction: z.string().regex(TRANSACTION_HEX).max(2_000_000),
  status: z.enum(["confirmed", "unconfirmed", "spent", "orphaned"]),
  blockHeight: z.number().int().nonnegative().optional(),
  blockHash: z.string().regex(HASH).optional(),
  spentBy: z.string().regex(HASH).optional(),
  assetId: z.string().regex(HASH),
  amount: z.string().regex(AMOUNT),
  scriptPubkey: z.string().regex(SCRIPT),
  assetConfidential: z.boolean(),
  valueConfidential: z.boolean(),
});

export const walletSyncUtxoSchema = z.discriminatedUnion("source", [
  syncedUtxoBaseSchema.extend({
    source: z.literal("wallet"),
    walletKey: z.object({
      branch: z.union([z.literal(0), z.literal(1)]),
      index: z.number().int().min(0).max(0x7fff_ffff),
    }).strict(),
  }).strict(),
  syncedUtxoBaseSchema.extend({
    source: z.literal("holder"),
    holderKey: z.object({
      derivationIndex: z.number().int().min(0).max(0x7fff_ffff),
      ownerPublicKey: z.string().regex(HASH),
    }).strict(),
  }).strict(),
]);
export type WalletSyncUtxo = z.infer<typeof walletSyncUtxoSchema>;

export const walletSyncSnapshotSchema = z.object({
  version: z.literal(walletSyncVersion),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  network: z.enum(["liquid-testnet", "elements-regtest"]),
  scope: z.union([z.literal("base"), z.string().regex(HASH)]),
  gapLimit: z.number().int().min(1).max(100),
  scannedThrough: z.object({ external: z.number().int().nonnegative(), change: z.number().int().nonnegative() }).strict(),
  tipHeight: z.number().int().nonnegative(),
  syncedAt: z.string().datetime(),
  addresses: z.array(walletSyncAddressSchema).max(2_100),
  utxos: z.array(walletSyncUtxoSchema).max(10_000),
}).strict();
export type WalletSyncSnapshot = z.infer<typeof walletSyncSnapshotSchema>;

const esploraStatusSchema = z.object({
  confirmed: z.boolean(),
  block_height: z.number().int().nonnegative().optional(),
  block_hash: z.string().regex(HASH).optional(),
  block_time: z.number().int().nonnegative().optional(),
});

const listedUtxoSchema = z.object({
  txid: z.string().regex(HASH),
  vout: z.number().int().nonnegative(),
  status: esploraStatusSchema,
});

const scripthashStatsSchema = z.object({
  chain_stats: z.object({ tx_count: z.number().int().nonnegative() }).passthrough(),
  mempool_stats: z.object({ tx_count: z.number().int().nonnegative() }).passthrough(),
}).passthrough();

const outspendSchema = z.object({
  spent: z.boolean(),
  txid: z.string().regex(HASH).optional(),
}).passthrough();

export type AddressScanResult = {
  hasActivity: boolean;
  utxos: Array<z.infer<typeof listedUtxoSchema>>;
};

export type OutspendResult = { exists: boolean; spent: boolean; txid?: string };

export type WalletDiscoveryDependencies = {
  deriveAddress: (branch: 0 | 1, index: number, network: SignerNetwork) => Promise<DerivedWalletAddress>;
  scanAddress: (esploraUrl: string, address: WalletSyncAddress, request: typeof fetch) => Promise<AddressScanResult>;
  fetchTransaction: (esploraUrl: string, txid: string, request: typeof fetch) => Promise<string>;
  fetchOutspend: (esploraUrl: string, txid: string, vout: number, request: typeof fetch) => Promise<OutspendResult>;
  fetchTipHeight: (esploraUrl: string, request: typeof fetch) => Promise<number>;
  inspect: (utxos: SpendableUtxo[]) => Promise<InspectedUtxo[]>;
  now: () => string;
};

const defaultDependencies: WalletDiscoveryDependencies = {
  deriveAddress: (branch, index, network) => deriveWalletAddress(branch, index, network),
  scanAddress: scanAddressAt,
  fetchTransaction,
  fetchOutspend,
  fetchTipHeight,
  inspect: inspectUtxos,
  now: () => new Date().toISOString(),
};

export function walletSyncStorageKey(fingerprint: string, network: SignerNetwork, scope: string) {
  return `${walletSyncVersion}:${fingerprint}:${network}:${scope}`;
}

export async function loadWalletSyncSnapshot(
  fingerprint: string,
  network: SignerNetwork,
  scope: string,
) {
  const stored = await getWalletSyncRecord<unknown>(walletSyncStorageKey(fingerprint, network, scope));
  const parsed = walletSyncSnapshotSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

export async function saveWalletSyncSnapshot(snapshot: WalletSyncSnapshot) {
  const parsed = walletSyncSnapshotSchema.parse(snapshot);
  await putWalletSyncRecord(
    walletSyncStorageKey(parsed.fingerprint, parsed.network, parsed.scope),
    parsed,
  );
  return parsed;
}

export async function discoverWalletSnapshot(input: {
  fingerprint: string;
  network: SignerNetwork;
  scope: string;
  esploraUrl: string;
  previous?: WalletSyncSnapshot;
  holderRecords?: StoredReceiveRecord[];
  gapLimit?: number;
  request?: typeof fetch;
  dependencies?: Partial<WalletDiscoveryDependencies>;
}): Promise<WalletSyncSnapshot> {
  const gapLimit = input.gapLimit ?? defaultWalletGapLimit;
  if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > 100) throw new Error("Wallet gap limit must be between 1 and 100.");
  const request = input.request ?? fetch;
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const previous = input.previous && walletSyncSnapshotSchema.parse(input.previous);
  const addresses: WalletSyncAddress[] = [];
  const scans: Array<{ address: WalletSyncAddress; scan: AddressScanResult }> = [];
  const scannedThrough = { external: 0, change: 0 };

  for (const branch of [0, 1] as const) {
    const knownMax = previous?.addresses
      .filter((address): address is z.infer<typeof walletAddressSchema> => address.source === "wallet" && address.branch === branch && address.hasActivity)
      .reduce((highest, address) => Math.max(highest, address.index), -1) ?? -1;
    let scanThrough = Math.max(gapLimit - 1, knownMax + gapLimit);
    let index = 0;
    while (index <= scanThrough) {
      const windowEnd = Math.min(scanThrough, index + gapLimit - 1);
      const derived = await Promise.all(
        Array.from({ length: windowEnd - index + 1 }, (_, offset) => dependencies.deriveAddress(branch, index + offset, input.network)),
      );
      const windowAddresses = derived.map((address): z.infer<typeof walletAddressSchema> => walletAddressSchema.parse({
        source: "wallet",
        branch,
        index: address.index,
        confidentialAddress: address.confidentialAddress,
        scriptPubkey: address.scriptPubkey,
        hasActivity: false,
      }));
      const windowScans = await Promise.all(windowAddresses.map((address) =>
        dependencies.scanAddress(input.esploraUrl, address, request)
      ));
      for (let offset = 0; offset < windowAddresses.length; offset += 1) {
        const scan = windowScans[offset];
        const address = walletAddressSchema.parse({ ...windowAddresses[offset], hasActivity: scan.hasActivity });
        addresses.push(address);
        scans.push({ address, scan });
        if (scan.hasActivity) scanThrough = Math.max(scanThrough, address.index + gapLimit);
      }
      if (scanThrough > maxDiscoveryIndex) throw new Error(`Wallet discovery exceeded index ${maxDiscoveryIndex}.`);
      index = windowEnd + 1;
    }
    if (branch === 0) scannedThrough.external = scanThrough;
    else scannedThrough.change = scanThrough;
  }

  const holderAddresses = (input.holderRecords ?? []).map(({ record, derivationIndex }): WalletSyncAddress =>
    holderAddressSchema.parse({
      source: "holder",
      derivationIndex,
      ownerPublicKey: record.ownerPublicKey,
      confidentialAddress: record.confidentialAddress,
      scriptPubkey: record.scriptPubkey,
      hasActivity: false,
    })
  );
  if (holderAddresses.length > 100) throw new Error("Wallet has too many local holder records to synchronize safely.");
  const holderScans = await Promise.all(holderAddresses.map((address) =>
    dependencies.scanAddress(input.esploraUrl, address, request)
  ));
  for (let index = 0; index < holderAddresses.length; index += 1) {
    const scan = holderScans[index];
    const address = { ...holderAddresses[index], hasActivity: scan.hasActivity } as WalletSyncAddress;
    addresses.push(address);
    scans.push({ address, scan });
  }

  const listed = new Map<string, { address: WalletSyncAddress; utxo: z.infer<typeof listedUtxoSchema> }>();
  for (const { address, scan } of scans) {
    for (const raw of scan.utxos) {
      const utxo = listedUtxoSchema.parse(raw);
      const key = `${utxo.txid}:${utxo.vout}`;
      const existing = listed.get(key);
      if (existing && addressIdentity(existing.address) !== addressIdentity(address)) {
        throw new Error(`Esplora assigned ${key} to conflicting wallet locators.`);
      }
      if (!existing && listed.size >= maxDiscoveredUtxos) {
        throw new Error(`Wallet discovery exceeded ${maxDiscoveredUtxos} current outputs.`);
      }
      listed.set(key, { address, utxo });
    }
  }

  const transactionIds = [...new Set([...listed.values()].map(({ utxo }) => utxo.txid))].sort();
  const transactions = new Map(await mapConcurrent(transactionIds, transactionFetchConcurrency, async (txid) => [
    txid,
    await dependencies.fetchTransaction(input.esploraUrl, txid, request),
  ] as const));
  const inspectable = [...listed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, { address, utxo }]): SpendableUtxo => ({
    txid: utxo.txid,
    vout: utxo.vout,
    transaction: transactions.get(utxo.txid)!,
    spendable: utxo.status.confirmed,
    ...(address.source === "wallet"
      ? { walletKey: { branch: address.branch, index: address.index } }
      : { holderKey: { derivationIndex: address.derivationIndex, ownerPublicKey: address.ownerPublicKey } }),
  }));
  const inspected = await dependencies.inspect(inspectable);
  const inspectedByOutpoint = new Map<string, InspectedUtxo>();
  for (const value of inspected) {
    const key = `${value.txid}:${value.vout}`;
    if (inspectedByOutpoint.has(key)) throw new Error(`Signer returned duplicate inspection for ${key}.`);
    inspectedByOutpoint.set(key, value);
  }
  if (inspectedByOutpoint.size !== inspectable.length) throw new Error("Signer did not inspect every discovered wallet output.");

  const current: WalletSyncUtxo[] = [...listed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, { address, utxo }]) => {
    const inspection = inspectedByOutpoint.get(key);
    if (!inspection) throw new Error(`Signer omitted inspection for ${key}.`);
    if (inspection.scriptPubkey !== address.scriptPubkey) throw new Error(`Signer inspection for ${key} returned another script.`);
    const common = {
      txid: utxo.txid,
      vout: utxo.vout,
      transaction: transactions.get(utxo.txid)!,
      status: utxo.status.confirmed ? "confirmed" as const : "unconfirmed" as const,
      blockHeight: utxo.status.block_height,
      blockHash: utxo.status.block_hash,
      assetId: inspection.assetId,
      amount: inspection.amount,
      scriptPubkey: inspection.scriptPubkey,
      assetConfidential: inspection.assetConfidential,
      valueConfidential: inspection.valueConfidential,
    };
    return address.source === "wallet"
      ? walletSyncUtxoSchema.parse({ ...common, source: "wallet", walletKey: { branch: address.branch, index: address.index } })
      : walletSyncUtxoSchema.parse({ ...common, source: "holder", holderKey: { derivationIndex: address.derivationIndex, ownerPublicKey: address.ownerPublicKey } });
  });

  const currentKeys = new Set(current.map((utxo) => `${utxo.txid}:${utxo.vout}`));
  const missing = (previous?.utxos ?? []).filter((utxo) =>
    !currentKeys.has(`${utxo.txid}:${utxo.vout}`) && (utxo.status === "confirmed" || utxo.status === "unconfirmed")
  );
  const reconciled = await Promise.all(missing.map(async (utxo): Promise<WalletSyncUtxo> => {
    const outspend = await dependencies.fetchOutspend(input.esploraUrl, utxo.txid, utxo.vout, request);
    if (!outspend.exists) return walletSyncUtxoSchema.parse({ ...utxo, status: "orphaned", blockHeight: undefined, blockHash: undefined, spentBy: undefined });
    if (!outspend.spent || !outspend.txid) throw new Error(`Previously tracked output ${utxo.txid}:${utxo.vout} disappeared without a spend.`);
    return walletSyncUtxoSchema.parse({ ...utxo, status: "spent", spentBy: outspend.txid });
  }));
  const historical = (previous?.utxos ?? []).filter((utxo) =>
    !currentKeys.has(`${utxo.txid}:${utxo.vout}`) && (utxo.status === "spent" || utxo.status === "orphaned")
  );
  const [tipHeight] = await Promise.all([dependencies.fetchTipHeight(input.esploraUrl, request)]);

  return walletSyncSnapshotSchema.parse({
    version: walletSyncVersion,
    fingerprint: input.fingerprint,
    network: input.network,
    scope: input.scope,
    gapLimit,
    scannedThrough,
    tipHeight,
    syncedAt: dependencies.now(),
    addresses: addresses.sort(compareAddresses),
    utxos: [...current, ...reconciled, ...historical].sort(compareUtxos),
  });
}

export async function synchronizeBaseWallet(input: {
  fingerprint: string;
  network: SignerNetwork;
  esploraUrl: string;
  request?: typeof fetch;
  dependencies?: Partial<WalletDiscoveryDependencies>;
}) {
  const revision = requireSignerIdentity(input.fingerprint, input.network);
  const previous = await loadWalletSyncSnapshot(input.fingerprint, input.network, "base");
  const snapshot = await discoverWalletSnapshot({ ...input, scope: "base", previous });
  requireSignerIdentity(input.fingerprint, input.network, revision);
  return saveWalletSyncSnapshot(snapshot);
}

export async function synchronizeDeploymentWallet(
  deployment: Deployment,
  fingerprint: string,
  options: { request?: typeof fetch; dependencies?: Partial<WalletDiscoveryDependencies> } = {},
) {
  const revision = requireSignerIdentity(fingerprint, deployment.network);
  const record = await ensureSignerReceiveRecord(deployment, fingerprint);
  const previous = await loadWalletSyncSnapshot(fingerprint, deployment.network, deployment.deploymentId);
  const snapshot = await discoverWalletSnapshot({
    fingerprint,
    network: deployment.network,
    scope: deployment.deploymentId,
    esploraUrl: esploraUrlForDeployment(deployment),
    previous,
    holderRecords: [record],
    ...options,
  });
  requireSignerIdentity(fingerprint, deployment.network, revision);
  return saveWalletSyncSnapshot(snapshot);
}

export type AssetBalance = {
  assetId: string;
  confirmed: bigint;
  pending: bigint;
  confirmedUtxos: number;
  pendingUtxos: number;
};

export function assetBalances(snapshot: WalletSyncSnapshot | undefined): AssetBalance[] {
  const balances = new Map<string, AssetBalance>();
  for (const utxo of snapshot?.utxos ?? []) {
    if (utxo.status !== "confirmed" && utxo.status !== "unconfirmed") continue;
    const balance = balances.get(utxo.assetId) ?? { assetId: utxo.assetId, confirmed: 0n, pending: 0n, confirmedUtxos: 0, pendingUtxos: 0 };
    if (utxo.status === "confirmed") {
      balance.confirmed += BigInt(utxo.amount);
      balance.confirmedUtxos += 1;
    } else {
      balance.pending += BigInt(utxo.amount);
      balance.pendingUtxos += 1;
    }
    balances.set(utxo.assetId, balance);
  }
  return [...balances.values()].sort((left, right) => left.assetId.localeCompare(right.assetId));
}

export function selectSpendableUtxos(
  snapshot: WalletSyncSnapshot,
  assetId: string,
  source?: WalletSyncUtxo["source"],
): SpendableUtxo[] {
  return snapshot.utxos
    .filter((utxo) => utxo.status === "confirmed" && utxo.assetId === assetId && (!source || utxo.source === source))
    .sort(compareUtxos)
    .map((utxo): SpendableUtxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      transaction: utxo.transaction,
      spendable: true,
      ...(utxo.source === "wallet" ? { walletKey: utxo.walletKey } : { holderKey: utxo.holderKey }),
    }));
}

export type FeeFundingState = "loading" | "ready" | "pending" | "unfunded" | "error";

export function feeFundingState(input: {
  snapshot?: WalletSyncSnapshot;
  assetId: string;
  minimum?: bigint;
  syncing?: boolean;
  syncError?: string;
}): FeeFundingState {
  if (input.syncError) return "error";
  if (!input.snapshot) return "loading";
  const minimum = input.minimum ?? 1n;
  const wallet = input.snapshot.utxos.filter((utxo) => utxo.source === "wallet" && utxo.assetId === input.assetId);
  if (wallet.some((utxo) => utxo.status === "confirmed" && BigInt(utxo.amount) >= minimum)) return "ready";
  if (wallet.some((utxo) => utxo.status === "unconfirmed" && BigInt(utxo.amount) >= minimum)) return "pending";
  if (input.syncing) return "loading";
  return "unfunded";
}

export function nextFundingAddress(snapshot: WalletSyncSnapshot | undefined) {
  return snapshot?.addresses
    .filter((address): address is z.infer<typeof walletAddressSchema> => address.source === "wallet" && address.branch === 0 && !address.hasActivity)
    .sort((left, right) => left.index - right.index)[0];
}

export function signerReceiveRecord(
  stored: StoredReceiveRecord[],
  ownerPublicKey: string,
  derivationIndex: number,
) {
  const matching = stored.find(({ record }) => record.ownerPublicKey === ownerPublicKey);
  if (matching && matching.derivationIndex !== derivationIndex) {
    throw new Error("Stored receive record uses the wrong holder derivation.");
  }
  return matching;
}

export async function ensureSignerReceiveRecord(deployment: Deployment, fingerprint: string) {
  const revision = requireSignerIdentity(fingerprint, deployment.network);
  const stored = await listReceiveRecords(deployment.deploymentId);
  // Derive the connected signer's deterministic holder identity first. A
  // deployment may contain public receive records for several mnemonics, but a
  // wallet sync must scan only the holder script controlled by this signer.
  const created = await createReceiveRecord(
    publicManifest(deployment),
    deployment.deploymentId,
    deployment.asset.ticker.toLowerCase(),
  );
  const derived = receiveRecordSchema.parse(created.record);
  await validateReceiveRecordShape(derived);
  await validateReceiveRecord(publicManifest(deployment), derived);

  const matching = signerReceiveRecord(stored, derived.ownerPublicKey, created.derivationIndex);
  if (!matching) {
    await putReceiveRecord(derived, created.derivationIndex);
    requireSignerIdentity(fingerprint, deployment.network, revision);
    return { record: derived, derivationIndex: created.derivationIndex };
  }

  const record = receiveRecordSchema.parse(matching.record);
  if (record.deploymentId !== deployment.deploymentId) {
    throw new Error("Stored receive record belongs to another deployment.");
  }
  await validateReceiveRecordShape(record);
  await validateReceiveRecord(publicManifest(deployment), record);
  requireSignerIdentity(fingerprint, deployment.network, revision);
  return { record, derivationIndex: matching.derivationIndex };
}

function requireSignerIdentity(
  fingerprint: string,
  network: SignerNetwork,
  revision = signerSessionRevision(),
) {
  const current = signerSnapshot();
  if (!current.connected || current.fingerprint !== fingerprint || current.network !== network) {
    throw new Error("The connected signer changed; restart wallet synchronization.");
  }
  if (signerSessionRevision() !== revision) {
    throw new Error("The connected signer changed; restart wallet synchronization.");
  }
  return revision;
}

async function scriptHash(scriptPubkey: string) {
  if (!SCRIPT.test(scriptPubkey)) throw new Error("Invalid wallet scriptPubKey hex.");
  const bytes = Uint8Array.from(scriptPubkey.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].reverse().map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function scanAddressAt(esploraUrl: string, address: WalletSyncAddress, request: typeof fetch) {
  const base = esploraUrl.replace(/\/$/, "");
  const hash = await scriptHash(address.scriptPubkey);
  const parsedStats = scripthashStatsSchema.parse(await getJson(request, `${base}/scripthash/${hash}`));
  const hasActivity = parsedStats.chain_stats.tx_count + parsedStats.mempool_stats.tx_count > 0;

  // A never-used address cannot have a UTXO. Avoid a second explorer request for
  // every empty gap address, which keeps first-run discovery responsive.
  if (!hasActivity) return { hasActivity, utxos: [] } satisfies AddressScanResult;

  const utxos = await getJson(request, `${base}/scripthash/${hash}/utxo`);
  return {
    hasActivity,
    utxos: z.array(listedUtxoSchema).max(maxDiscoveredUtxos).parse(utxos),
  } satisfies AddressScanResult;
}

async function fetchTransaction(esploraUrl: string, txid: string, request: typeof fetch) {
  const response = await request(`${esploraUrl.replace(/\/$/, "")}/tx/${txid}/hex`, { cache: "no-store", headers: { Accept: "text/plain" } });
  if (!response.ok) throw new Error(`Esplora transaction fetch failed (${response.status}).`);
  return z.string().regex(TRANSACTION_HEX).max(maxTransactionHexBytes).parse((await readResponseText(response, maxTransactionHexBytes)).trim());
}

async function fetchOutspend(esploraUrl: string, txid: string, vout: number, request: typeof fetch): Promise<OutspendResult> {
  const response = await request(`${esploraUrl.replace(/\/$/, "")}/tx/${txid}/outspend/${vout}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (response.status === 404) return { exists: false, spent: false };
  if (!response.ok) throw new Error(`Esplora outspend fetch failed (${response.status}).`);
  const parsed = outspendSchema.parse(await readJsonResponse(response));
  return { exists: true, spent: parsed.spent, txid: parsed.txid };
}

async function fetchTipHeight(esploraUrl: string, request: typeof fetch) {
  const response = await request(`${esploraUrl.replace(/\/$/, "")}/blocks/tip/height`, { cache: "no-store", headers: { Accept: "text/plain" } });
  if (!response.ok) throw new Error(`Esplora tip fetch failed (${response.status}).`);
  const height = Number(await readResponseText(response, 32));
  if (!Number.isSafeInteger(height) || height < 0) throw new Error("Esplora returned an invalid chain height.");
  return height;
}

async function getJson(request: typeof fetch, url: string) {
  const response = await request(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Esplora request failed (${response.status}) for ${url}.`);
  return readJsonResponse(response);
}

async function readJsonResponse(response: Response) {
  const text = await readResponseText(response, maxJsonResponseBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Esplora returned invalid JSON.");
  }
}

async function readResponseText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Esplora response is too large.");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Esplora response is too large.");
    return text;
  }

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Esplora response is too large.");
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

function addressIdentity(address: WalletSyncAddress) {
  return address.source === "wallet"
    ? `wallet:${address.branch}:${address.index}`
    : `holder:${address.ownerPublicKey}:${address.derivationIndex}`;
}

function compareAddresses(left: WalletSyncAddress, right: WalletSyncAddress) {
  return addressIdentity(left).localeCompare(addressIdentity(right));
}

function compareUtxos(left: Pick<WalletSyncUtxo, "txid" | "vout">, right: Pick<WalletSyncUtxo, "txid" | "vout">) {
  return left.txid.localeCompare(right.txid) || left.vout - right.vout;
}

export function validOutpoint(value: string) {
  return OUTPOINT.test(value);
}
