import { beforeEach, describe, expect, it, vi } from "vitest";

const storedWallets = vi.hoisted(() => new Map<string, unknown>());
const currentSigner = vi.hoisted(() => ({
  fingerprint: "aabbccdd",
  profileId: `elements-regtest:${"aa".repeat(32)}`,
  network: "elements-regtest" as const,
  revision: 1,
}));

vi.mock("./amp-signer", async () => {
  const actual = await vi.importActual<typeof import("./amp-signer")>("./amp-signer");
  return {
    ...actual,
    signerSnapshot: () => ({ connected: true, fingerprint: currentSigner.fingerprint, profileId: currentSigner.profileId, network: currentSigner.network }),
    signerSessionRevision: () => currentSigner.revision,
  };
});

vi.mock("./store", () => ({
  getWalletSyncRecord: (key: string) => Promise.resolve(storedWallets.get(key)),
  putWalletSyncRecord: (key: string, value: unknown) => {
    storedWallets.set(key, structuredClone(value));
    return Promise.resolve(key);
  },
  listReceiveRecords: () => Promise.resolve([]),
  putReceiveRecord: () => Promise.resolve(),
}));

import type { DerivedWalletAddress, InspectedUtxo, SpendableUtxo } from "./amp-signer";
import {
  assetBalances,
  discoverWalletSnapshot,
  feeFundingState,
  issuanceFundingPlan,
  loadWalletSyncSnapshot,
  saveWalletSyncSnapshot,
  selectSpendableUtxos,
  signerReceiveRecord,
  synchronizeBaseWallet,
  WalletDiscoverySafetyError,
  walletSyncStorageKey,
  type AddressScanResult,
  type WalletDiscoveryDependencies,
  type WalletSyncAddress,
  type WalletSyncSnapshot,
} from "./wallet-sync";

const fingerprint = "aabbccdd";
const profileId = `elements-regtest:${"aa".repeat(32)}`;
const policyAsset = "11".repeat(32);
const regulatedAsset = "22".repeat(32);

function txid(byte: string) {
  return byte.repeat(64);
}

function scriptFor(branch: number, index: number) {
  return `${branch.toString(16).padStart(2, "0")}${index.toString(16).padStart(2, "0")}51`;
}

function address(branch: 0 | 1, index: number): DerivedWalletAddress {
  return {
    sdk: "test",
    branch,
    index,
    derivationPath: `m/${branch}/${index}`,
    confidentialAddress: `ert1${branch}${index}${"q".repeat(30)}`,
    scriptPubkey: scriptFor(branch, index),
  };
}

function listed(id: string, confirmed: boolean) {
  return {
    txid: id,
    vout: 0,
    status: confirmed
      ? { confirmed: true, block_height: 90, block_hash: txid("c") }
      : { confirmed: false },
  };
}

function dependencies(input: {
  scans?: (address: WalletSyncAddress) => AddressScanResult;
  outspend?: WalletDiscoveryDependencies["fetchOutspend"];
  inspect?: WalletDiscoveryDependencies["inspect"];
} = {}): Partial<WalletDiscoveryDependencies> {
  return {
    deriveAddress: (branch, index) => Promise.resolve(address(branch, index)),
    scanAddress: (_esplora, value) => Promise.resolve(input.scans?.(value) ?? { hasActivity: false, utxos: [] }),
    fetchTransaction: () => Promise.resolve("00"),
    fetchOutspend: input.outspend ?? (() => Promise.resolve({ exists: false, spent: false })),
    fetchTipHeight: () => Promise.resolve(100),
    inspect: input.inspect ?? ((utxos: SpendableUtxo[]) => Promise.resolve(utxos.map((utxo): InspectedUtxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      assetId: policyAsset,
      amount: utxo.spendable ? "5000" : "7000",
      scriptPubkey: scriptFor(utxo.walletKey?.branch ?? 0, utxo.walletKey?.index ?? 0),
      assetConfidential: false,
      valueConfidential: true,
    })))),
    now: () => "2026-08-20T12:00:00.000Z",
  };
}

async function discover(input: {
  previous?: WalletSyncSnapshot;
  gapLimit?: number;
  dependencies?: Partial<WalletDiscoveryDependencies>;
} = {}) {
  return discoverWalletSnapshot({
    profileId,
    network: "elements-regtest",
    scope: "base",
    source: { provider: "esplora", baseUrl: "http://esplora.test/api" },
    previous: input.previous,
    gapLimit: input.gapLimit ?? 2,
    dependencies: input.dependencies ?? dependencies(),
  });
}

describe("wallet discovery", () => {
  beforeEach(() => {
    storedWallets.clear();
    currentSigner.fingerprint = fingerprint;
    currentSigner.profileId = profileId;
    currentSigner.revision = 1;
    localStorage.setItem("simplicity-amp:regtest-esplora", "http://esplora.test/api");
  });

  it("extends both branches through a full unused gap after the last used address", async () => {
    const pendingTxid = txid("a");
    const snapshot = await discover({
      dependencies: dependencies({
        scans: (value) => value.source === "wallet" && value.branch === 0 && value.index === 1
          ? { hasActivity: true, utxos: [listed(pendingTxid, false)] }
          : { hasActivity: false, utxos: [] },
      }),
    });

    expect(snapshot.scannedThrough).toEqual({ external: 3, change: 1 });
    expect(snapshot.addresses.flatMap((value) => value.source === "wallet" && value.branch === 0 ? [value.index] : [])).toEqual([0, 1, 2, 3]);
    expect(snapshot.utxos[0]).toMatchObject({ txid: pendingTxid, status: "unconfirmed", amount: "7000" });
  });

  it("treats spent-only address history as used and reconciles missing outputs", async () => {
    const priorTxid = txid("b");
    const previous = await discover({
      gapLimit: 1,
      dependencies: dependencies({ scans: (value) => value.source === "wallet" && value.branch === 0 && value.index === 0 ? { hasActivity: true, utxos: [listed(priorTxid, true)] } : { hasActivity: false, utxos: [] } }),
    });
    const replacement = await discover({
      previous,
      gapLimit: 1,
      dependencies: dependencies({
        scans: (value) => value.source === "wallet" && value.branch === 0 && value.index === 0 ? { hasActivity: true, utxos: [] } : { hasActivity: false, utxos: [] },
        outspend: () => Promise.resolve({ exists: true, spent: true, txid: txid("d") }),
      }),
    });

    expect(replacement.utxos).toHaveLength(1);
    expect(replacement.utxos[0]).toMatchObject({ status: "spent", spentBy: txid("d") });
  });

  it("deduplicates matching listings and rejects conflicting locators", async () => {
    const duplicate = txid("e");
    await expect(discover({
      gapLimit: 1,
      dependencies: dependencies({
        scans: (value) => value.source === "wallet" && value.branch === 0 && value.index <= 1
          ? { hasActivity: true, utxos: [listed(duplicate, true)] }
          : { hasActivity: false, utxos: [] },
      }),
    })).rejects.toThrow("conflicting wallet locators");
  });

  it("bounds explorer output fan-out before fetching parent transactions", async () => {
    const flood = Array.from({ length: 1_001 }, (_, index) => listed(index.toString(16).padStart(64, "0"), true));
    await expect(discover({
      gapLimit: 1,
      dependencies: dependencies({
        scans: (value) => value.source === "wallet" && value.branch === 0 && value.index === 0
          ? { hasActivity: true, utxos: flood }
          : { hasActivity: false, utxos: [] },
      }),
    })).rejects.toThrow("exceeded 1000 current outputs");
  });

  it("deduplicates repeated parent transactions before budgeted fetching", async () => {
    const parent = txid("7");
    const fetchTransaction = vi.fn(() => Promise.resolve("00"));
    const outputs = Array.from({ length: 20 }, (_, vout) => ({
      txid: parent,
      vout,
      status: { confirmed: true, block_height: 90, block_hash: txid("c") },
    }));

    const snapshot = await discover({
      gapLimit: 1,
      dependencies: {
        ...dependencies({
          scans: (value) => value.source === "wallet" && value.branch === 0 && value.index === 0
            ? { hasActivity: true, utxos: outputs }
            : { hasActivity: false, utxos: [] },
        }),
        fetchTransaction,
      },
    });

    expect(snapshot.utxos).toHaveLength(20);
    expect(fetchTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects too many unique parent transactions before starting fetches", async () => {
    const fetchTransaction = vi.fn(() => Promise.resolve("00"));
    const outputs = Array.from({ length: 257 }, (_, index) => ({
      txid: index.toString(16).padStart(64, "0"),
      vout: 0,
      status: { confirmed: true, block_height: 90, block_hash: txid("c") },
    }));

    await expect(discover({
      gapLimit: 1,
      dependencies: {
        ...dependencies({
          scans: (value) => value.source === "wallet" && value.branch === 0 && value.index === 0
            ? { hasActivity: true, utxos: outputs }
            : { hasActivity: false, utxos: [] },
        }),
        fetchTransaction,
      },
    })).rejects.toMatchObject({
      code: "WALLET_DISCOVERY_SAFETY_LIMIT",
      limit: "parent-transactions",
    } satisfies Partial<WalletDiscoverySafetyError>);
    expect(fetchTransaction).not.toHaveBeenCalled();
  });

  it("enforces the aggregate response-byte budget across concurrent parent fetches", async () => {
    const parentTxids = Array.from({ length: 33 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
    const outputs = parentTxids.map((parentTxid) => ({
      txid: parentTxid,
      vout: 0,
      status: { confirmed: true, block_height: 90, block_hash: txid("c") },
    }));
    const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new Uint8Array(1_000_000))));

    await expect(discoverWalletSnapshot({
      profileId,
      network: "liquid-testnet",
      scope: "base",
      source: {
        provider: "waterfalls-v4",
        baseUrl: "https://waterfalls.test/api",
        utxoFallbackUrl: "https://esplora.test/api",
        outspendFallbackUrl: "https://esplora.test/api",
      },
      gapLimit: 1,
      request,
      dependencies: {
        deriveAddress: (branch, index) => Promise.resolve(address(branch, index)),
        scanAddress: (_source, value) => Promise.resolve({
          hasActivity: value.source === "wallet" && value.branch === 0 && value.index === 0,
          utxos: value.source === "wallet" && value.branch === 0 && value.index === 0 ? outputs : [],
          historyTxids: value.source === "wallet" && value.branch === 0 && value.index === 0 ? parentTxids : [],
          historyComplete: true,
          tipHash: txid("f"),
          tipHeight: 100,
        }),
        inspect: () => Promise.resolve([]),
        now: () => "2026-08-20T12:00:00.000Z",
      },
    })).rejects.toMatchObject({
      code: "WALLET_DISCOVERY_SAFETY_LIMIT",
      limit: "response-bytes",
    } satisfies Partial<WalletDiscoverySafetyError>);
    expect(request.mock.calls.length).toBeLessThanOrEqual(33);
  });
});

describe("wallet state and persistence", () => {
  beforeEach(() => {
    storedWallets.clear();
    currentSigner.fingerprint = fingerprint;
    currentSigner.profileId = profileId;
    currentSigner.revision = 1;
    localStorage.setItem("simplicity-amp:regtest-esplora", "http://esplora.test/api");
  });

  it("aggregates assets without counting spent outputs and selects only confirmed sources", async () => {
    const confirmed = txid("1");
    const pending = txid("2");
    const snapshot = await discover({
      dependencies: dependencies({
        scans: (value) => {
          if (value.source !== "wallet" || value.branch !== 0) return { hasActivity: false, utxos: [] };
          if (value.index === 0) return { hasActivity: true, utxos: [listed(confirmed, true)] };
          if (value.index === 1) return { hasActivity: true, utxos: [listed(pending, false)] };
          return { hasActivity: false, utxos: [] };
        },
        inspect: (utxos) => Promise.resolve(utxos.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          assetId: utxo.txid === confirmed ? policyAsset : regulatedAsset,
          amount: utxo.txid === confirmed ? "5000" : "7",
          scriptPubkey: scriptFor(utxo.walletKey!.branch, utxo.walletKey!.index),
          assetConfidential: false,
          valueConfidential: true,
        }))),
      }),
    });

    expect(assetBalances(snapshot)).toEqual([
      { assetId: policyAsset, confirmed: 5000n, pending: 0n, confirmedUtxos: 1, pendingUtxos: 0 },
      { assetId: regulatedAsset, confirmed: 0n, pending: 7n, confirmedUtxos: 0, pendingUtxos: 1 },
    ]);
    expect(selectSpendableUtxos(snapshot, policyAsset, "wallet")).toHaveLength(1);
    expect(selectSpendableUtxos(snapshot, regulatedAsset, "wallet")).toHaveLength(0);
    expect(feeFundingState({ snapshot, assetId: policyAsset, minimum: 1_500n })).toBe("ready");
    expect(feeFundingState({ snapshot, assetId: regulatedAsset, minimum: 1n })).toBe("pending");
    expect(feeFundingState({ snapshot, assetId: policyAsset, syncError: "offline" })).toBe("error");
    expect(feeFundingState({ snapshot, assetId: "33".repeat(32) })).toBe("unfunded");
    expect(feeFundingState({ snapshot, assetId: "33".repeat(32), syncing: true })).toBe("loading");
    expect(feeFundingState({ assetId: policyAsset, syncing: true })).toBe("loading");
  });

  it("reuses two confirmed issuance outputs without requesting the faucet", async () => {
    const first = txid("4");
    const second = txid("5");
    const snapshot = await discover({
      dependencies: dependencies({
        scans: (value) => {
          if (value.source !== "wallet" || value.branch !== 0) return { hasActivity: false, utxos: [] };
          if (value.index === 0) return { hasActivity: true, utxos: [listed(first, true)] };
          if (value.index === 1) return { hasActivity: true, utxos: [listed(second, true)] };
          return { hasActivity: false, utxos: [] };
        },
      }),
    });

    expect(issuanceFundingPlan({ snapshot, assetId: policyAsset })).toMatchObject({
      confirmedOutputs: 2,
      confirmedBalance: 10_000n,
      ready: true,
      projectedReady: true,
      faucetOutputs: 0,
    });
  });

  it("suppresses duplicate faucet requests for pending funding and requests only the missing shape", async () => {
    const confirmed = txid("6");
    const pending = txid("7");
    const snapshot = await discover({
      dependencies: dependencies({
        scans: (value) => {
          if (value.source !== "wallet" || value.branch !== 0) return { hasActivity: false, utxos: [] };
          if (value.index === 0) return { hasActivity: true, utxos: [listed(confirmed, true)] };
          if (value.index === 1) return { hasActivity: true, utxos: [listed(pending, false)] };
          return { hasActivity: false, utxos: [] };
        },
      }),
    });

    expect(issuanceFundingPlan({ snapshot, assetId: policyAsset })).toMatchObject({
      confirmedOutputs: 1,
      pendingOutputs: 1,
      ready: false,
      projectedReady: true,
      faucetOutputs: 0,
    });
    expect(issuanceFundingPlan({ snapshot, assetId: policyAsset, requiredAmount: 20_000n })).toMatchObject({
      projectedReady: false,
      faucetOutputs: 1,
    });
  });

  it("restores the same strong profile snapshot and isolates another mnemonic", async () => {
    const snapshot = await discover();
    await saveWalletSyncSnapshot(snapshot);

    await expect(loadWalletSyncSnapshot(profileId, "elements-regtest", "base")).resolves.toEqual(snapshot);
    const otherProfileId = `elements-regtest:${"bb".repeat(32)}`;
    await expect(loadWalletSyncSnapshot(otherProfileId, "elements-regtest", "base")).resolves.toBeUndefined();
    expect(walletSyncStorageKey(profileId, "elements-regtest", "base")).not.toBe(walletSyncStorageKey(otherProfileId, "elements-regtest", "base"));
  });

  it("selects only the connected signer's deployment receive record", () => {
    const first = { record: { ownerPublicKey: txid("1") }, derivationIndex: 7 };
    const second = { record: { ownerPublicKey: txid("2") }, derivationIndex: 7 };
    const records = [first, second] as Parameters<typeof signerReceiveRecord>[0];

    expect(signerReceiveRecord(records, txid("2"), 7)).toBe(second);
    expect(signerReceiveRecord(records, txid("3"), 7)).toBeUndefined();
    expect(() => signerReceiveRecord(records, txid("1"), 8)).toThrow("wrong holder derivation");
  });

  it("keeps the last good persisted snapshot when a refresh fails", async () => {
    const snapshot = await discover();
    await saveWalletSyncSnapshot(snapshot);
    await expect(synchronizeBaseWallet({
      profileId,
      network: "elements-regtest",
      dependencies: dependencies({ scans: () => { throw new Error("network failed"); } }),
    })).rejects.toThrow("network failed");
    await expect(loadWalletSyncSnapshot(profileId, "elements-regtest", "base")).resolves.toEqual(snapshot);
  });

  it("keeps the last good snapshot when adversarial activity exhausts the global address budget", async () => {
    const snapshot = await discover();
    await saveWalletSyncSnapshot(snapshot);
    await expect(synchronizeBaseWallet({
      profileId,
      network: "elements-regtest",
      dependencies: dependencies({ scans: () => ({ hasActivity: true, utxos: [] }) }),
    })).rejects.toMatchObject({
      code: "WALLET_DISCOVERY_SAFETY_LIMIT",
      limit: "addresses",
    } satisfies Partial<WalletDiscoverySafetyError>);
    await expect(loadWalletSyncSnapshot(profileId, "elements-regtest", "base")).resolves.toEqual(snapshot);
  });

  it("does not persist a scan if the connected signer changes mid-refresh", async () => {
    const snapshot = await discover();
    await saveWalletSyncSnapshot(snapshot);
    await expect(synchronizeBaseWallet({
      profileId,
      network: "elements-regtest",
      dependencies: {
        ...dependencies(),
        fetchTipHeight: () => {
          currentSigner.revision += 1;
          currentSigner.fingerprint = "11223344";
          currentSigner.profileId = `elements-regtest:${"bb".repeat(32)}`;
          return Promise.resolve(101);
        },
      },
    })).rejects.toThrow("connected signer changed");
    await expect(loadWalletSyncSnapshot(profileId, "elements-regtest", "base")).resolves.toEqual(snapshot);
  });
});
