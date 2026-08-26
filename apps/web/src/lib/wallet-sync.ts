import { z } from "zod";
import { Buffer } from "buffer";
import { address as liquidAddress, networks as liquidNetworks, Transaction } from "liquidjs-lib";

import {
  deriveHolderAddress,
  deriveWalletAddress,
  inspectUtxos,
  markSignerWalletReady,
  signerSessionRevision,
  signerSnapshot,
  validateRecipientAddress,
  type DerivedHolderAddress,
  type DerivedWalletAddress,
  type InspectedUtxo,
  type SignerNetwork,
  type SpendableUtxo,
} from "./amp-signer";
import {
  HASH,
  SCRIPT,
  publicManifest,
  type Deployment,
} from "./domain";
import {
  getWalletSyncRecord,
  putWalletSyncRecord,
} from "./store";
import { walletDiscoverySource, type WalletDiscoverySource } from "./wallet-source";

export const walletSyncVersion = 3 as const;
export const defaultWalletGapLimit = 10;
const maxDiscoveryIndex = 999;
const maxDiscoveredUtxos = 1_000;
const maxHistoryTransactions = 2_000;
const maxWaterfallsPages = 20;
const maxJsonResponseBytes = 1_000_000;
const maxTransactionHexBytes = 2_000_000;
const transactionFetchConcurrency = 8;

/**
 * One synchronization shares these limits across both wallet branches and all
 * holder scripts. The default gap scan examines 20 wallet addresses; these
 * ceilings leave room for a mature PoC wallet while bounding a hostile public
 * discovery service to work that a browser can safely discard.
 */
export const walletDiscoveryLimits = Object.freeze({
  maxRequests: 512,
  maxResponseBytes: 32_000_000,
  maxAddresses: 256,
  maxHistoryEntries: 10_000,
  maxParentTransactions: 256,
  maxFallbackRequests: 64,
  maxElapsedMs: 45_000,
});

export type WalletDiscoveryLimit =
  | "requests"
  | "response-bytes"
  | "addresses"
  | "history-entries"
  | "parent-transactions"
  | "fallback-requests"
  | "elapsed";

export class WalletDiscoverySafetyError extends Error {
  readonly code = "WALLET_DISCOVERY_SAFETY_LIMIT" as const;

  constructor(readonly limit: WalletDiscoveryLimit) {
    super("Wallet synchronization stopped because the discovery service exceeded its safety budget. Retry later.");
    this.name = "WalletDiscoverySafetyError";
  }
}

export class WalletDiscoveryCancelledError extends Error {
  readonly code = "WALLET_DISCOVERY_CANCELLED" as const;

  constructor() {
    super("Wallet synchronization was cancelled.");
    this.name = "AbortError";
  }
}
const OUTPOINT = /^[0-9a-f]{64}:[0-9]+$/;
const AMOUNT = /^(0|[1-9][0-9]*)$/;
const TRANSACTION_HEX = /^(?:[0-9a-f]{2})+$/;
const SIGNED_I32_MIN = -0x8000_0000;
const SIGNED_I32_MAX = 0x7fff_ffff;
const UNSIGNED_I32_MAX = 0xffff_ffff;

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
  profileId: z.string().regex(/^(liquid-testnet|elements-regtest):[0-9a-f]{64}$/),
  network: z.enum(["liquid-testnet", "elements-regtest"]),
  discoveryProvider: z.enum(["waterfalls-v4", "esplora"]),
  scope: z.union([z.literal("base"), z.string().regex(HASH)]),
  gapLimit: z.number().int().min(1).max(100),
  scannedThrough: z.object({ external: z.number().int().nonnegative(), change: z.number().int().nonnegative() }).strict(),
  tipHeight: z.number().int().nonnegative(),
  tipHash: z.string().regex(HASH).optional(),
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

const esploraTipBlockSchema = z.object({
  id: z.string().regex(HASH),
  height: z.number().int().nonnegative(),
}).passthrough();

const scripthashStatsSchema = z.object({
  chain_stats: z.object({ tx_count: z.number().int().nonnegative() }).passthrough(),
  mempool_stats: z.object({ tx_count: z.number().int().nonnegative() }).passthrough(),
}).passthrough();

const outspendSchema = z.object({
  spent: z.boolean(),
  txid: z.string().regex(HASH).optional(),
}).passthrough();

const waterfallsTxSeenSchema = z.object({
  txid: z.string().regex(HASH),
  height: z.number().int().min(0).max(UNSIGNED_I32_MAX),
  block_hash: z.string().regex(HASH).optional(),
  block_timestamp: z.number().int().min(0).max(UNSIGNED_I32_MAX).optional(),
  // Waterfalls serializes its V enum as a signed i32: positive values are
  // vout + 1, negative values are -(vin + 1), and zero/omitted is undefined.
  // Confirmed full-history scans intentionally omit undefined positions.
  v: z.number().int().min(SIGNED_I32_MIN).max(SIGNED_I32_MAX).optional(),
}).strict();

const waterfallsResponseSchema = z.object({
  txs_seen: z.object({ addresses: z.array(z.array(waterfallsTxSeenSchema)).length(1) }).strict(),
  has_more: z.array(z.string().min(1)).max(1).optional(),
  page: z.number().int().nonnegative(),
  tip_meta: z.object({
    b: z.string().regex(HASH),
    t: z.number().int().nonnegative(),
    h: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type AddressScanResult = {
  hasActivity: boolean;
  utxos: Array<z.infer<typeof listedUtxoSchema>>;
  historyTxids?: string[];
  historyComplete?: boolean;
  tipHash?: string;
  tipHeight?: number;
};

export type OutspendResult = { exists: boolean; spent: boolean; txid?: string };

export type WalletDiscoveryDependencies = {
  deriveAddress: (branch: 0 | 1, index: number, network: SignerNetwork) => Promise<DerivedWalletAddress>;
  scanAddress: (source: WalletDiscoverySource, address: WalletSyncAddress, request: typeof fetch, budget: WalletDiscoveryWorkBudget) => Promise<AddressScanResult>;
  fetchTransaction: (source: WalletDiscoverySource, txid: string, request: typeof fetch, budget: WalletDiscoveryWorkBudget) => Promise<string>;
  fetchOutspend: (source: WalletDiscoverySource, txid: string, vout: number, request: typeof fetch, budget: WalletDiscoveryWorkBudget) => Promise<OutspendResult>;
  fetchTipHeight: (source: WalletDiscoverySource, request: typeof fetch, budget: WalletDiscoveryWorkBudget) => Promise<number>;
  inspect: (utxos: SpendableUtxo[]) => Promise<InspectedUtxo[]>;
  now: () => string;
};

class WalletDiscoveryWorkBudget {
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly source: WalletDiscoverySource;
  private readonly externalSignal?: AbortSignal;
  private failure?: WalletDiscoverySafetyError | WalletDiscoveryCancelledError;
  private requests = 0;
  private responseBytes = 0;
  private addresses = 0;
  private historyEntries = 0;
  private readonly parentTransactions = new Set<string>();
  private readonly transactionHex = new Map<string, Promise<string>>();
  private fallbackRequests = 0;

  constructor(source: WalletDiscoverySource, signal?: AbortSignal) {
    this.source = source;
    this.externalSignal = signal;
    if (signal?.aborted) this.cancel();
    else signal?.addEventListener("abort", this.cancel, { once: true });
    this.timer = setTimeout(() => this.setFailure("elapsed"), walletDiscoveryLimits.maxElapsedMs);
  }

  finish() {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener("abort", this.cancel);
  }

  abortPending() {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  assertActive() {
    if (!this.failure && Date.now() - this.startedAt > walletDiscoveryLimits.maxElapsedMs) this.fail("elapsed");
    if (this.failure) throw this.failure;
  }

  examineAddresses(count: number) {
    this.addresses = this.charge("addresses", this.addresses, count, walletDiscoveryLimits.maxAddresses);
  }

  retainHistoryEntries(count: number) {
    this.historyEntries = this.charge("history-entries", this.historyEntries, count, walletDiscoveryLimits.maxHistoryEntries);
  }

  fetchParentTransactions(txids: readonly string[]) {
    this.assertActive();
    for (const txid of txids) {
      if (this.parentTransactions.has(txid)) continue;
      if (this.parentTransactions.size >= walletDiscoveryLimits.maxParentTransactions) this.fail("parent-transactions");
      this.parentTransactions.add(txid);
    }
  }

  fetchTransaction(txid: string, loader: () => Promise<string>) {
    this.fetchParentTransactions([txid]);
    const existing = this.transactionHex.get(txid);
    if (existing) return existing;
    const pending = loader();
    this.transactionHex.set(txid, pending);
    return pending;
  }

  expectResponseBytes(count: number) {
    if (count > walletDiscoveryLimits.maxResponseBytes - this.responseBytes) this.fail("response-bytes");
  }

  retainResponseBytes(count: number) {
    this.responseBytes = this.charge("response-bytes", this.responseBytes, count, walletDiscoveryLimits.maxResponseBytes);
  }

  async fetch(request: typeof fetch, input: RequestInfo | URL, init?: RequestInit) {
    this.assertActive();
    this.requests = this.charge("requests", this.requests, 1, walletDiscoveryLimits.maxRequests);
    if (this.isFallback(input)) {
      this.fallbackRequests = this.charge(
        "fallback-requests",
        this.fallbackRequests,
        1,
        walletDiscoveryLimits.maxFallbackRequests,
      );
    }

    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(this.failure ?? new WalletDiscoveryCancelledError());
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(request(input, { ...init, signal: this.controller.signal })).then(
        (response) => {
          this.controller.signal.removeEventListener("abort", onAbort);
          try {
            this.assertActive();
            resolve(response);
          } catch (error) {
            reject(error);
          }
        },
        (error: unknown) => {
          this.controller.signal.removeEventListener("abort", onAbort);
          reject(this.failure ?? error);
        },
      );
    });
  }

  private readonly cancel = () => {
    if (this.failure) return;
    this.failure = new WalletDiscoveryCancelledError();
    this.controller.abort(this.failure);
  };

  private isFallback(input: RequestInfo | URL) {
    if (this.source.provider !== "waterfalls-v4") return false;
    const url = String(input);
    return [this.source.utxoFallbackUrl, this.source.outspendFallbackUrl]
      .some((base) => url.startsWith(base.replace(/\/$/, "")));
  }

  private charge(limit: WalletDiscoveryLimit, current: number, count: number, maximum: number) {
    this.assertActive();
    if (!Number.isSafeInteger(count) || count < 0 || count > maximum - current) this.fail(limit);
    return current + count;
  }

  private fail(limit: WalletDiscoveryLimit): never {
    this.setFailure(limit);
    throw this.failure;
  }

  private setFailure(limit: WalletDiscoveryLimit) {
    if (this.failure) return;
    this.failure = new WalletDiscoverySafetyError(limit);
    this.controller.abort(this.failure);
  }
}

const defaultDependencies: WalletDiscoveryDependencies = {
  deriveAddress: (branch, index, network) => deriveWalletAddress(branch, index, network),
  scanAddress: scanAddressWithSource,
  fetchTransaction: fetchTransactionFromSource,
  fetchOutspend: fetchOutspendFromSource,
  fetchTipHeight: fetchTipHeightFromSource,
  inspect: inspectUtxos,
  now: () => new Date().toISOString(),
};

export function walletSyncStorageKey(profileId: string, network: SignerNetwork, scope: string) {
  return `${walletSyncVersion}:${profileId}:${network}:${scope}`;
}

export async function loadWalletSyncSnapshot(
  profileId: string,
  network: SignerNetwork,
  scope: string,
) {
  const stored = await getWalletSyncRecord<unknown>(walletSyncStorageKey(profileId, network, scope));
  const parsed = walletSyncSnapshotSchema.safeParse(stored);
  return parsed.success && parsed.data.profileId === profileId && parsed.data.network === network && parsed.data.scope === scope
    ? parsed.data
    : undefined;
}

export async function saveWalletSyncSnapshot(snapshot: WalletSyncSnapshot) {
  const parsed = walletSyncSnapshotSchema.parse(snapshot);
  await putWalletSyncRecord(
    walletSyncStorageKey(parsed.profileId, parsed.network, parsed.scope),
    parsed,
  );
  return parsed;
}

export async function discoverWalletSnapshot(input: {
  profileId: string;
  network: SignerNetwork;
  scope: string;
  source: WalletDiscoverySource;
  previous?: WalletSyncSnapshot;
  holderAddresses?: DerivedHolderAddress[];
  gapLimit?: number;
  signal?: AbortSignal;
  request?: typeof fetch;
  dependencies?: Partial<WalletDiscoveryDependencies>;
}): Promise<WalletSyncSnapshot> {
  const gapLimit = input.gapLimit ?? defaultWalletGapLimit;
  if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > 100) throw new Error("Wallet gap limit must be between 1 and 100.");
  const request = input.request ?? fetch;
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const budget = new WalletDiscoveryWorkBudget(input.source, input.signal);
  try {
  const previous = input.previous && walletSyncSnapshotSchema.parse(input.previous);
  if (previous && previous.discoveryProvider !== input.source.provider) {
    throw new Error("The persisted wallet snapshot belongs to another discovery provider.");
  }
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
      budget.examineAddresses(windowEnd - index + 1);
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
      const windowScans = await mapConcurrent(windowAddresses, transactionFetchConcurrency, async (address) => {
        budget.assertActive();
        return dependencies.scanAddress(input.source, address, request, budget);
      }, budget);
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

  const holderAddresses = (input.holderAddresses ?? []).map((holder): WalletSyncAddress =>
    holderAddressSchema.parse({
      source: "holder",
      derivationIndex: holder.derivationIndex,
      ownerPublicKey: holder.ownerPublicKey,
      confidentialAddress: holder.confidentialAddress,
      scriptPubkey: holder.scriptPubkey,
      hasActivity: false,
    })
  );
  if (holderAddresses.length > 100) throw new Error("Wallet has too many local holder records to synchronize safely.");
  budget.examineAddresses(holderAddresses.length);
  const holderScans = await mapConcurrent(holderAddresses, transactionFetchConcurrency, (address) =>
    dependencies.scanAddress(input.source, address, request, budget), budget
  );
  for (let index = 0; index < holderAddresses.length; index += 1) {
    const scan = holderScans[index];
    const address = { ...holderAddresses[index], hasActivity: scan.hasActivity } as WalletSyncAddress;
    addresses.push(address);
    scans.push({ address, scan });
  }

  const historyByAddress = new Map<string, { txids: Set<string>; complete: boolean }>();
  let waterfallsTip: { hash: string; height: number } | undefined;
  if (input.source.provider === "waterfalls-v4") {
    for (const { address, scan } of scans) {
      if (!scan.tipHash || scan.tipHeight === undefined || !scan.historyTxids) {
        throw new Error("Waterfalls omitted wallet history or chain-tip metadata.");
      }
      if (waterfallsTip && (waterfallsTip.hash !== scan.tipHash || waterfallsTip.height !== scan.tipHeight)) {
        throw new Error("Waterfalls chain tip changed during wallet discovery; retry the synchronization.");
      }
      waterfallsTip = { hash: scan.tipHash, height: scan.tipHeight };
      historyByAddress.set(addressIdentity(address), {
        txids: new Set(scan.historyTxids),
        complete: scan.historyComplete === true,
      });
    }
    if (!waterfallsTip) throw new Error("Waterfalls returned no chain-tip metadata.");
  }

  const listed = new Map<string, { address: WalletSyncAddress; utxo: z.infer<typeof listedUtxoSchema> }>();
  for (const { address, scan } of scans) {
    for (const raw of scan.utxos) {
      const utxo = listedUtxoSchema.parse(raw);
      const key = `${utxo.txid}:${utxo.vout}`;
      const existing = listed.get(key);
      if (existing && addressIdentity(existing.address) !== addressIdentity(address)) {
        throw new Error(`The discovery provider assigned ${key} to conflicting wallet locators.`);
      }
      if (!existing && listed.size >= maxDiscoveredUtxos) {
        throw new Error(`Wallet discovery exceeded ${maxDiscoveredUtxos} current outputs.`);
      }
      listed.set(key, { address, utxo });
    }
  }

  const transactionIds = [...new Set([...listed.values()].map(({ utxo }) => utxo.txid))].sort();
  budget.fetchParentTransactions(transactionIds);
  const transactions = new Map(await mapConcurrent(transactionIds, transactionFetchConcurrency, async (txid) => [
    txid,
    await dependencies.fetchTransaction(input.source, txid, request, budget),
  ] as const, budget));
  const inspectable = [...listed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, { address, utxo }]): SpendableUtxo => ({
    txid: utxo.txid,
    vout: utxo.vout,
    transaction: transactions.get(utxo.txid)!,
    spendable: utxo.status.confirmed,
    ...(address.source === "wallet"
      ? { walletKey: { branch: address.branch, index: address.index } }
      : { holderKey: { derivationIndex: address.derivationIndex, ownerPublicKey: address.ownerPublicKey } }),
  }));
  budget.assertActive();
  const inspected = await dependencies.inspect(inspectable);
  budget.assertActive();
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
  const reconciled = await mapConcurrent(missing, transactionFetchConcurrency, async (utxo): Promise<WalletSyncUtxo> => {
    if (input.source.provider === "waterfalls-v4") {
      const locator = utxo.source === "wallet"
        ? `wallet:${utxo.walletKey.branch}:${utxo.walletKey.index}`
        : `holder:${utxo.holderKey.ownerPublicKey}:${utxo.holderKey.derivationIndex}`;
      const history = historyByAddress.get(locator);
      if (!history) throw new Error(`Waterfalls omitted the history for ${locator}.`);
      if (history.complete && !history.txids.has(utxo.txid)) {
        return walletSyncUtxoSchema.parse({ ...utxo, status: "orphaned", blockHeight: undefined, blockHash: undefined, spentBy: undefined });
      }
    }
    const outspend = await dependencies.fetchOutspend(input.source, utxo.txid, utxo.vout, request, budget);
    if (!outspend.exists) return walletSyncUtxoSchema.parse({ ...utxo, status: "orphaned", blockHeight: undefined, blockHash: undefined, spentBy: undefined });
    if (!outspend.spent || !outspend.txid) throw new Error(`Previously tracked output ${utxo.txid}:${utxo.vout} disappeared without a spend.`);
    return walletSyncUtxoSchema.parse({ ...utxo, status: "spent", spentBy: outspend.txid });
  }, budget);
  const historical = (previous?.utxos ?? []).filter((utxo) =>
    !currentKeys.has(`${utxo.txid}:${utxo.vout}`) && (utxo.status === "spent" || utxo.status === "orphaned")
  );
  const tipHeight = waterfallsTip?.height ?? await dependencies.fetchTipHeight(input.source, request, budget);

  return walletSyncSnapshotSchema.parse({
    version: walletSyncVersion,
    profileId: input.profileId,
    network: input.network,
    discoveryProvider: input.source.provider,
    scope: input.scope,
    gapLimit,
    scannedThrough,
    tipHeight,
    tipHash: waterfallsTip?.hash,
    syncedAt: dependencies.now(),
    addresses: addresses.sort(compareAddresses),
    utxos: [...current, ...reconciled, ...historical].sort(compareUtxos),
  });
  } catch (error) {
    budget.abortPending();
    throw error;
  } finally {
    budget.finish();
  }
}

export async function synchronizeBaseWallet(input: {
  profileId: string;
  network: SignerNetwork;
  signal?: AbortSignal;
  request?: typeof fetch;
  dependencies?: Partial<WalletDiscoveryDependencies>;
}) {
  const revision = requireSignerIdentity(input.profileId, input.network);
  const previous = await loadWalletSyncSnapshot(input.profileId, input.network, "base");
  const snapshot = await discoverWalletSnapshot({
    ...input,
    source: walletDiscoverySource(input.network),
    scope: "base",
    previous,
  });
  requireSignerIdentity(input.profileId, input.network, revision);
  const saved = await saveWalletSyncSnapshot(snapshot);
  requireSignerIdentity(input.profileId, input.network, revision);
  markSignerWalletReady(input.profileId, input.network);
  return saved;
}

export async function synchronizeDeploymentWallet(
  deployment: Deployment,
  profileId: string,
  options: { signal?: AbortSignal; request?: typeof fetch; dependencies?: Partial<WalletDiscoveryDependencies> } = {},
) {
  const revision = requireSignerIdentity(profileId, deployment.network);
  const holderAddress = await ensureSignerHolderAddress(deployment, profileId);
  const previous = await loadWalletSyncSnapshot(profileId, deployment.network, deployment.deploymentId);
  const snapshot = await discoverWalletSnapshot({
    profileId,
    network: deployment.network,
    scope: deployment.deploymentId,
    source: walletDiscoverySource(deployment.network),
    previous,
    holderAddresses: [holderAddress],
    ...options,
  });
  requireSignerIdentity(profileId, deployment.network, revision);
  const saved = await saveWalletSyncSnapshot(snapshot);
  requireSignerIdentity(profileId, deployment.network, revision);
  markSignerWalletReady(profileId, deployment.network);
  return saved;
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

export type IssuanceFundingPlan = {
  confirmedOutputs: number;
  pendingOutputs: number;
  confirmedBalance: bigint;
  pendingBalance: bigint;
  ready: boolean;
  projectedReady: boolean;
  faucetOutputs: number;
  splitOffer: boolean;
  splitCandidate?: Pick<WalletSyncUtxo, "txid" | "vout" | "amount">;
};

export const SPLIT_FUNDING_FEE = 500n;
export const SPLIT_FUNDING_MINIMUM = 5_000n;

/**
 * Summarizes the exact funding shape required by bootstrap. Issuance consumes
 * two distinct L-BTC inputs, so a single large output is not sufficient. A
 * pending output is included only when deciding whether another faucet request
 * would be redundant; it never makes the signer-ready state true.
 */
export function issuanceFundingPlan(input: {
  snapshot?: WalletSyncSnapshot;
  assetId: string;
  requiredOutputs?: number;
  requiredAmount?: bigint;
}): IssuanceFundingPlan {
  const requiredOutputs = input.requiredOutputs ?? 2;
  const requiredAmount = input.requiredAmount ?? 2_000n;
  if (!Number.isSafeInteger(requiredOutputs) || requiredOutputs < 1) {
    throw new Error("Issuance requires at least one funding output.");
  }
  if (requiredAmount < 0n) throw new Error("Issuance funding amount cannot be negative.");

  const funding = (input.snapshot?.utxos ?? []).filter((utxo) =>
    utxo.source === "wallet" && utxo.assetId === input.assetId
  );
  const confirmed = funding.filter((utxo) => utxo.status === "confirmed");
  const pending = funding.filter((utxo) => utxo.status === "unconfirmed");
  const confirmedBalance = confirmed.reduce((total, utxo) => total + BigInt(utxo.amount), 0n);
  const pendingBalance = pending.reduce((total, utxo) => total + BigInt(utxo.amount), 0n);
  const ready = confirmed.length >= requiredOutputs && confirmedBalance >= requiredAmount;
  const projectedOutputs = confirmed.length + pending.length;
  const projectedBalance = confirmedBalance + pendingBalance;
  const projectedReady = projectedOutputs >= requiredOutputs && projectedBalance >= requiredAmount;
  const faucetOutputs = projectedReady
    ? 0
    : Math.max(
      Math.max(0, requiredOutputs - projectedOutputs),
      projectedBalance < requiredAmount ? 1 : 0,
    );
  const splitOffer = confirmed.length === 1
    && pending.length === 0
    && BigInt(confirmed[0].amount) >= SPLIT_FUNDING_MINIMUM;
  const splitCandidate = splitOffer
    ? { txid: confirmed[0].txid, vout: confirmed[0].vout, amount: confirmed[0].amount }
    : undefined;

  return {
    confirmedOutputs: confirmed.length,
    pendingOutputs: pending.length,
    confirmedBalance,
    pendingBalance,
    ready,
    projectedReady,
    faucetOutputs,
    splitOffer,
    splitCandidate,
  };
}

export function nextFundingAddress(snapshot: WalletSyncSnapshot | undefined) {
  return snapshot?.addresses
    .filter((address): address is z.infer<typeof walletAddressSchema> => address.source === "wallet" && address.branch === 0 && !address.hasActivity)
    .sort((left, right) => left.index - right.index)[0];
}

export async function ensureSignerHolderAddress(deployment: Deployment, profileId: string) {
  const revision = requireSignerIdentity(profileId, deployment.network);
  const derived = await deriveHolderAddress(publicManifest(deployment));
  const owner = await validateRecipientAddress(publicManifest(deployment), derived.confidentialAddress);
  if (owner !== derived.ownerPublicKey) throw new Error("Derived holder address owner mismatch.");
  requireSignerIdentity(profileId, deployment.network, revision);
  return derived;
}

function requireSignerIdentity(
  profileId: string,
  network: SignerNetwork,
  revision = signerSessionRevision(),
) {
  const current = signerSnapshot();
  if (!current.connected || current.profileId !== profileId || current.network !== network) {
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

async function scanAddressWithSource(
  source: WalletDiscoverySource,
  address: WalletSyncAddress,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
) {
  return source.provider === "waterfalls-v4"
    ? scanWaterfallsAddressWithBudget(source, address, request, budget)
    : scanEsploraAddress(source.baseUrl, address, request, budget);
}

async function scanEsploraAddress(
  esploraUrl: string,
  address: WalletSyncAddress,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
) {
  const base = esploraUrl.replace(/\/$/, "");
  const hash = await scriptHash(address.scriptPubkey);
  const parsedStats = scripthashStatsSchema.parse(await getJson(request, `${base}/scripthash/${hash}`, budget));
  const hasActivity = parsedStats.chain_stats.tx_count + parsedStats.mempool_stats.tx_count > 0;

  // A never-used address cannot have a UTXO. Avoid a second explorer request for
  // every empty gap address, which keeps first-run discovery responsive.
  if (!hasActivity) return { hasActivity, utxos: [] } satisfies AddressScanResult;

  const utxos = await getJson(request, `${base}/scripthash/${hash}/utxo`, budget);
  return {
    hasActivity,
    utxos: z.array(listedUtxoSchema).max(maxDiscoveredUtxos).parse(utxos),
  } satisfies AddressScanResult;
}

export async function scanWaterfallsAddress(
  source: Extract<WalletDiscoverySource, { provider: "waterfalls-v4" }>,
  address: WalletSyncAddress,
  request: typeof fetch,
): Promise<AddressScanResult> {
  const budget = new WalletDiscoveryWorkBudget(source);
  budget.examineAddresses(1);
  try {
    return await scanWaterfallsAddressWithBudget(source, address, request, budget);
  } finally {
    budget.finish();
  }
}

async function scanWaterfallsAddressWithBudget(
  source: Extract<WalletDiscoverySource, { provider: "waterfalls-v4" }>,
  address: WalletSyncAddress,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
): Promise<AddressScanResult> {
  let decoded: ReturnType<typeof liquidAddress.fromConfidential>;
  try {
    decoded = liquidAddress.fromConfidential(address.confidentialAddress);
  } catch {
    throw new Error("The signer returned an invalid confidential address for Waterfalls discovery.");
  }
  if (!decoded.scriptPubKey || decoded.scriptPubKey.toString("hex") !== address.scriptPubkey) {
    throw new Error("The Waterfalls address does not match the signer-derived scriptPubKey.");
  }
  if (liquidAddress.getNetwork(decoded.unconfidentialAddress) !== liquidNetworks.testnet) {
    throw new Error("Waterfalls wallet discovery accepts only Liquid testnet addresses.");
  }

  const base = source.baseUrl.replace(/\/$/, "");
  const history = new Set<string>();
  const historyEvidence = new Map<string, z.infer<typeof waterfallsTxSeenSchema>>();
  const historyRecords: Array<z.infer<typeof waterfallsTxSeenSchema>> = [];
  const historyOutputs = new Map<string, z.infer<typeof listedUtxoSchema>>();
  const historyInputs: Array<{ txid: string; vin: number }> = [];
  let hasUndefinedPositions = false;
  let page = 0;
  let hadMore = false;
  let tip: { hash: string; height: number } | undefined;

  while (true) {
    if (page >= maxWaterfallsPages) throw new Error(`Waterfalls history exceeded ${maxWaterfallsPages} pages.`);
    const response = await getWaterfallsPage(request, base, decoded.unconfidentialAddress, page, false, budget);
    tip = requireConsistentWaterfallsTip(tip, response);
    budget.retainHistoryEntries(response.txs_seen.addresses[0].length);
    for (const item of response.txs_seen.addresses[0]) {
      requireWaterfallsHistoryHeight(item, tip);
      history.add(item.txid);
      historyRecords.push(item);
      const existingEvidence = historyEvidence.get(item.txid);
      if (existingEvidence && !sameWaterfallsTransactionEvidence(existingEvidence, item)) {
        throw new Error(`Waterfalls returned conflicting confirmation evidence for transaction ${item.txid}.`);
      }
      if (!existingEvidence || (existingEvidence.block_timestamp === undefined && item.block_timestamp !== undefined)) {
        historyEvidence.set(item.txid, item);
      }
      if (history.size > maxHistoryTransactions) {
        throw new Error(`Waterfalls history exceeded ${maxHistoryTransactions} transactions.`);
      }
      const position = item.v ?? 0;
      if (position > 0) {
        const output = listedWaterfallsOutput(item, tip);
        const key = `${output.txid}:${output.vout}`;
        const existing = historyOutputs.get(key);
        if (existing && !sameListedUtxo(existing, output)) {
          throw new Error(`Waterfalls returned conflicting history for output ${key}.`);
        }
        historyOutputs.set(key, output);
      } else if (position < 0) {
        historyInputs.push({ txid: item.txid, vin: -position - 1 });
      } else {
        hasUndefinedPositions = true;
      }
    }
    if (response.has_more?.some((value) => value !== decoded.unconfidentialAddress)) {
      throw new Error("Waterfalls returned pagination metadata for an unrequested address.");
    }
    const hasMore = response.has_more?.includes(decoded.unconfidentialAddress) === true;
    if (!hasMore) break;
    hadMore = true;
    page += 1;
  }
  if (!tip) throw new Error("Waterfalls omitted chain-tip metadata.");

  let utxos: Array<z.infer<typeof listedUtxoSchema>> = [];
  if (history.size > 0) {
    if (hadMore) {
      // Waterfalls rejects utxo_only for histories above its configured cap.
      // This explicit fallback is used only for that server limitation. It is
      // accepted only when both providers report the exact same tip and every
      // fallback output matches Waterfalls' output and confirmation evidence.
      const reconstructed = hasUndefinedPositions
        ? await reconstructWaterfallsHistory(
            source,
            address.scriptPubkey,
            tip,
            historyEvidence,
            historyRecords,
            request,
            budget,
          )
        : undefined;
      const provenOutputs = reconstructed?.outputs ?? historyOutputs;
      const spentOutpoints = reconstructed?.spentOutpoints
        ?? await fetchWaterfallsSpentOutpoints(source, historyInputs, request, budget);
      utxos = await fetchCoherentEsploraUtxos(
        source.utxoFallbackUrl,
        address.scriptPubkey,
        tip,
        provenOutputs,
        spentOutpoints,
        request,
        budget,
      );
    } else {
      const response = await getWaterfallsPage(request, base, decoded.unconfidentialAddress, 0, true, budget);
      requireConsistentWaterfallsTip(tip, response);
      if (response.has_more?.length) throw new Error("Waterfalls unexpectedly truncated a UTXO-only response.");
      const seen = new Set<string>();
      utxos = response.txs_seen.addresses[0].map((item) => {
        if (item.v === undefined || item.v <= 0) {
          throw new Error("Waterfalls UTXO response omitted a positive output position.");
        }
        const historyItem = historyEvidence.get(item.txid);
        if (!historyItem || !sameWaterfallsTransactionEvidence(historyItem, item)) {
          throw new Error(`Waterfalls history and UTXO views disagreed about transaction ${item.txid}.`);
        }
        const output = listedWaterfallsOutput(item, tip);
        const key = `${output.txid}:${output.vout}`;
        if (seen.has(key)) throw new Error(`Waterfalls returned duplicate output ${key}.`);
        seen.add(key);
        return output;
      });
      if (utxos.length > maxDiscoveredUtxos) throw new Error(`Waterfalls returned more than ${maxDiscoveredUtxos} outputs.`);
    }
    if (utxos.some((utxo) => !history.has(utxo.txid))) {
      throw new Error("Wallet discovery sources disagreed about an output's funding transaction.");
    }
  }

  return {
    hasActivity: history.size > 0,
    utxos,
    historyTxids: [...history].sort(),
    historyComplete: true,
    tipHash: tip.hash,
    tipHeight: tip.height,
  };
}

async function getWaterfallsPage(
  request: typeof fetch,
  baseUrl: string,
  unconfidentialAddress: string,
  page: number,
  utxoOnly: boolean,
  budget: WalletDiscoveryWorkBudget,
) {
  const query = new URLSearchParams({ addresses: unconfidentialAddress, page: String(page) });
  if (utxoOnly) query.set("utxo_only", "true");
  const response = await budget.fetch(request, `${baseUrl}/v4/waterfalls?${query}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Waterfalls request failed (${response.status}).`);
  const parsed = waterfallsResponseSchema.parse(await readJsonResponse(response, "Waterfalls", budget));
  if (parsed.page !== page) throw new Error("Waterfalls returned the wrong history page.");
  return parsed;
}

function requireConsistentWaterfallsTip(
  expected: { hash: string; height: number } | undefined,
  response: z.infer<typeof waterfallsResponseSchema>,
) {
  const next = { hash: response.tip_meta.b, height: response.tip_meta.h };
  if (expected && (expected.hash !== next.hash || expected.height !== next.height)) {
    throw new Error("Waterfalls chain tip changed during address discovery; retry the synchronization.");
  }
  return next;
}

function requireWaterfallsBlockHash(item: z.infer<typeof waterfallsTxSeenSchema>) {
  if (!item.block_hash) throw new Error("Waterfalls omitted the block hash for a confirmed output.");
  return item.block_hash;
}

function listedWaterfallsOutput(
  item: z.infer<typeof waterfallsTxSeenSchema>,
  tip: { hash: string; height: number },
) {
  if (item.v === undefined || item.v <= 0) throw new Error("Waterfalls output evidence omitted a positive position.");
  return listedWaterfallsOutputAt(item, item.v - 1, tip);
}

function listedWaterfallsOutputAt(
  item: z.infer<typeof waterfallsTxSeenSchema>,
  vout: number,
  tip: { hash: string; height: number },
) {
  if (item.height > tip.height) throw new Error("Waterfalls returned an output confirmed above its chain tip.");
  return listedUtxoSchema.parse({
    txid: item.txid,
    vout,
    status: item.height === 0
      ? { confirmed: false }
      : { confirmed: true, block_height: item.height, block_hash: requireWaterfallsBlockHash(item) },
  });
}

function sameWaterfallsTransactionEvidence(
  left: z.infer<typeof waterfallsTxSeenSchema>,
  right: z.infer<typeof waterfallsTxSeenSchema>,
) {
  return left.height === right.height
    && left.block_hash === right.block_hash
    && (left.block_timestamp === undefined
      || right.block_timestamp === undefined
      || left.block_timestamp === right.block_timestamp);
}

function requireWaterfallsHistoryHeight(
  item: z.infer<typeof waterfallsTxSeenSchema>,
  tip: { hash: string; height: number },
) {
  if (item.height > tip.height) throw new Error("Waterfalls returned history confirmed above its chain tip.");
  if (item.height > 0) requireWaterfallsBlockHash(item);
}

function sameListedUtxo(
  left: z.infer<typeof listedUtxoSchema>,
  right: z.infer<typeof listedUtxoSchema>,
) {
  return left.txid === right.txid
    && left.vout === right.vout
    && left.status.confirmed === right.status.confirmed
    && left.status.block_height === right.status.block_height
    && left.status.block_hash === right.status.block_hash;
}

async function fetchCoherentEsploraUtxos(
  esploraUrl: string,
  scriptPubkey: string,
  waterfallsTip: { hash: string; height: number },
  historyOutputs: Map<string, z.infer<typeof listedUtxoSchema>>,
  spentOutpoints: Set<string>,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
) {
  const before = await fetchEsploraTip(esploraUrl, request, budget);
  requireSameDiscoveryTip(waterfallsTip, before);
  const hash = await scriptHash(scriptPubkey);
  const value = await getJson(request, `${esploraUrl.replace(/\/$/, "")}/scripthash/${hash}/utxo`, budget);
  const utxos = z.array(listedUtxoSchema).max(maxDiscoveredUtxos).parse(value);
  const after = await fetchEsploraTip(esploraUrl, request, budget);
  requireSameDiscoveryTip(waterfallsTip, after);
  requireSameDiscoveryTip(before, after);

  const seen = new Set<string>();
  for (const utxo of utxos) {
    const key = `${utxo.txid}:${utxo.vout}`;
    if (seen.has(key)) throw new Error(`Esplora returned duplicate fallback output ${key}.`);
    seen.add(key);
    const expected = historyOutputs.get(key);
    if (!expected) throw new Error(`Waterfalls did not prove fallback output ${key}.`);
    if (spentOutpoints.has(key)) throw new Error(`Waterfalls proved fallback output ${key} was already spent.`);
    if (utxo.status.confirmed) {
      if (utxo.status.block_height === undefined || !utxo.status.block_hash) {
        throw new Error(`Esplora omitted confirmation proof for fallback output ${key}.`);
      }
      if (utxo.status.block_height > waterfallsTip.height) {
        throw new Error(`Esplora confirmed fallback output ${key} above the shared chain tip.`);
      }
    }
    if (!sameListedUtxo(expected, utxo)) {
      throw new Error(`Wallet discovery sources disagreed about fallback output ${key}.`);
    }
  }
  const expectedUnspent = [...historyOutputs.keys()].filter((key) => !spentOutpoints.has(key));
  const omitted = expectedUnspent.find((key) => !seen.has(key));
  if (omitted) throw new Error(`Esplora omitted Waterfalls-proven fallback output ${omitted}.`);
  if (seen.size !== expectedUnspent.length) {
    throw new Error("Wallet discovery sources returned different fallback output sets.");
  }
  return utxos;
}

async function fetchWaterfallsSpentOutpoints(
  source: Extract<WalletDiscoverySource, { provider: "waterfalls-v4" }>,
  historyInputs: Array<{ txid: string; vin: number }>,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
) {
  const spendingTxids = [...new Set(historyInputs.map(({ txid }) => txid))].sort();
  budget.fetchParentTransactions(spendingTxids);
  const transactions = new Map(await mapConcurrent(spendingTxids, transactionFetchConcurrency, async (txid) => {
    const transactionHex = await fetchTransactionFromSource(source, txid, request, budget);
    let transaction: Transaction;
    try {
      transaction = Transaction.fromHex(transactionHex);
    } catch {
      throw new Error(`Waterfalls returned an invalid spending transaction ${txid}.`);
    }
    if (transaction.getId() !== txid) throw new Error(`Waterfalls returned another spending transaction for ${txid}.`);
    return [txid, transaction] as const;
  }, budget));

  const spent = new Set<string>();
  for (const { txid, vin } of historyInputs) {
    const input = transactions.get(txid)?.ins[vin];
    if (!input) throw new Error(`Waterfalls history referenced missing input ${txid}:${vin}.`);
    const fundingTxid = Buffer.from(input.hash).reverse().toString("hex");
    spent.add(`${fundingTxid}:${input.index}`);
  }
  return spent;
}

async function reconstructWaterfallsHistory(
  source: Extract<WalletDiscoverySource, { provider: "waterfalls-v4" }>,
  addressScriptPubkey: string,
  tip: { hash: string; height: number },
  evidence: Map<string, z.infer<typeof waterfallsTxSeenSchema>>,
  records: Array<z.infer<typeof waterfallsTxSeenSchema>>,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
) {
  const txids = [...evidence.keys()].sort();
  budget.fetchParentTransactions(txids);
  const transactions = new Map(await mapConcurrent(txids, transactionFetchConcurrency, async (txid) => {
    const transactionHex = await fetchTransactionFromSource(source, txid, request, budget);
    let transaction: Transaction;
    try {
      transaction = Transaction.fromHex(transactionHex);
    } catch {
      throw new Error(`Waterfalls returned an invalid history transaction ${txid}.`);
    }
    if (transaction.getId() !== txid) throw new Error(`Waterfalls returned another history transaction for ${txid}.`);
    return [txid, transaction] as const;
  }, budget));

  const outputs = new Map<string, z.infer<typeof listedUtxoSchema>>();
  const involved = new Set<string>();
  for (const [txid, transaction] of transactions) {
    const item = evidence.get(txid);
    if (!item) throw new Error(`Waterfalls omitted confirmation evidence for history transaction ${txid}.`);
    transaction.outs.forEach((output, vout) => {
      if (output.script.toString("hex") !== addressScriptPubkey) return;
      const listed = listedWaterfallsOutputAt(item, vout, tip);
      outputs.set(`${txid}:${vout}`, listed);
      involved.add(txid);
    });
  }

  const spentOutpoints = new Set<string>();
  for (const [txid, transaction] of transactions) {
    for (const input of transaction.ins) {
      const fundingTxid = Buffer.from(input.hash).reverse().toString("hex");
      const key = `${fundingTxid}:${input.index}`;
      if (!outputs.has(key)) continue;
      spentOutpoints.add(key);
      involved.add(txid);
    }
  }

  for (const record of records) {
    const position = record.v ?? 0;
    if (position === 0) continue;
    const transaction = transactions.get(record.txid);
    if (!transaction) throw new Error(`Waterfalls omitted history transaction ${record.txid}.`);
    if (position > 0) {
      const vout = position - 1;
      if (transaction.outs[vout]?.script.toString("hex") !== addressScriptPubkey || !outputs.has(`${record.txid}:${vout}`)) {
        throw new Error(`Waterfalls output position disagreed with transaction ${record.txid}:${vout}.`);
      }
    } else {
      const vin = -position - 1;
      const input = transaction.ins[vin];
      if (!input) throw new Error(`Waterfalls history referenced missing input ${record.txid}:${vin}.`);
      const key = `${Buffer.from(input.hash).reverse().toString("hex")}:${input.index}`;
      if (!outputs.has(key)) throw new Error(`Waterfalls input position disagreed with transaction ${record.txid}:${vin}.`);
    }
  }

  const unrelated = txids.find((txid) => !involved.has(txid));
  if (unrelated) throw new Error(`Waterfalls history transaction ${unrelated} did not involve the requested address.`);
  return { outputs, spentOutpoints };
}

async function fetchEsploraTip(
  esploraUrl: string,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
) {
  const base = esploraUrl.replace(/\/$/, "");
  const hashResponse = await budget.fetch(request, `${base}/blocks/tip/hash`, { cache: "no-store", headers: { Accept: "text/plain" } });
  if (!hashResponse.ok) throw new Error(`Esplora tip hash fetch failed (${hashResponse.status}).`);
  const hash = (await readResponseText(hashResponse, 128, budget)).trim();
  if (!HASH.test(hash)) throw new Error("Esplora returned an invalid chain-tip hash.");
  const block = esploraTipBlockSchema.parse(await getJson(request, `${base}/block/${hash}`, budget));
  if (block.id !== hash) throw new Error("Esplora returned another block for its chain-tip hash.");
  return { hash, height: block.height };
}

function requireSameDiscoveryTip(
  expected: { hash: string; height: number },
  actual: { hash: string; height: number },
) {
  if (expected.hash !== actual.hash || expected.height !== actual.height) {
    throw new Error("Wallet discovery providers reported different chain tips; retry the synchronization.");
  }
}

async function fetchTransactionFromSource(
  source: WalletDiscoverySource,
  txid: string,
  request: typeof fetch,
  budget: WalletDiscoveryWorkBudget,
) {
  return budget.fetchTransaction(txid, async () => {
    if (source.provider === "waterfalls-v4") {
      const response = await budget.fetch(request, `${source.baseUrl.replace(/\/$/, "")}/tx/${txid}/raw`, {
        cache: "no-store",
        headers: { Accept: "application/octet-stream" },
      });
      if (!response.ok) throw new Error(`Waterfalls transaction fetch failed (${response.status}).`);
      const bytes = await readResponseBytes(response, maxTransactionHexBytes / 2, budget);
      return z.string().regex(TRANSACTION_HEX).max(maxTransactionHexBytes).parse(Buffer.from(bytes).toString("hex"));
    }
    return fetchEsploraTransaction(source.baseUrl, txid, request, budget);
  });
}

async function fetchEsploraTransaction(esploraUrl: string, txid: string, request: typeof fetch, budget: WalletDiscoveryWorkBudget) {
  const response = await budget.fetch(request, `${esploraUrl.replace(/\/$/, "")}/tx/${txid}/hex`, { cache: "no-store", headers: { Accept: "text/plain" } });
  if (!response.ok) throw new Error(`Esplora transaction fetch failed (${response.status}).`);
  return z.string().regex(TRANSACTION_HEX).max(maxTransactionHexBytes).parse((await readResponseText(response, maxTransactionHexBytes, budget)).trim());
}

async function fetchOutspendFromSource(source: WalletDiscoverySource, txid: string, vout: number, request: typeof fetch, budget: WalletDiscoveryWorkBudget): Promise<OutspendResult> {
  const esploraUrl = source.provider === "waterfalls-v4" ? source.outspendFallbackUrl : source.baseUrl;
  const response = await budget.fetch(request, `${esploraUrl.replace(/\/$/, "")}/tx/${txid}/outspend/${vout}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (response.status === 404) return { exists: false, spent: false };
  if (!response.ok) throw new Error(`Esplora outspend fetch failed (${response.status}).`);
  const parsed = outspendSchema.parse(await readJsonResponse(response, "Esplora", budget));
  return { exists: true, spent: parsed.spent, txid: parsed.txid };
}

async function fetchTipHeightFromSource(source: WalletDiscoverySource, request: typeof fetch, budget: WalletDiscoveryWorkBudget) {
  if (source.provider === "waterfalls-v4") throw new Error("Waterfalls tip height must come from the synchronized discovery response.");
  const esploraUrl = source.baseUrl;
  const response = await budget.fetch(request, `${esploraUrl.replace(/\/$/, "")}/blocks/tip/height`, { cache: "no-store", headers: { Accept: "text/plain" } });
  if (!response.ok) throw new Error(`Esplora tip fetch failed (${response.status}).`);
  const height = Number(await readResponseText(response, 32, budget));
  if (!Number.isSafeInteger(height) || height < 0) throw new Error("Esplora returned an invalid chain height.");
  return height;
}

async function getJson(request: typeof fetch, url: string, budget: WalletDiscoveryWorkBudget) {
  const response = await budget.fetch(request, url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Esplora request failed (${response.status}) for ${url}.`);
  return readJsonResponse(response, "Esplora", budget);
}

async function readJsonResponse(response: Response, provider = "Esplora", budget?: WalletDiscoveryWorkBudget) {
  const text = await readResponseText(response, maxJsonResponseBytes, budget);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${provider} returned invalid JSON.`);
  }
}

async function readResponseBytes(response: Response, maxBytes: number, budget?: WalletDiscoveryWorkBudget) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Discovery provider response is too large.");
  }
  if (Number.isFinite(contentLength) && contentLength >= 0) budget?.expectResponseBytes(contentLength);
  const reader = response.body?.getReader();
  if (!reader) {
    const value = new Uint8Array(await response.arrayBuffer());
    if (value.byteLength > maxBytes) throw new Error("Discovery provider response is too large.");
    budget?.retainResponseBytes(value.byteLength);
    return value;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    budget?.retainResponseBytes(value.byteLength);
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Discovery provider response is too large.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function readResponseText(response: Response, maxBytes: number, budget?: WalletDiscoveryWorkBudget) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("Discovery provider response is too large.");
  if (Number.isFinite(contentLength) && contentLength >= 0) budget?.expectResponseBytes(contentLength);
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) throw new Error("Discovery provider response is too large.");
    budget?.retainResponseBytes(byteLength);
    return text;
  }

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    budget?.retainResponseBytes(value.byteLength);
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Discovery provider response is too large.");
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
  budget?: WalletDiscoveryWorkBudget,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      budget?.assertActive();
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
