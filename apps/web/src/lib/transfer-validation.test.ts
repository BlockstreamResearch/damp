import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signerValidation = vi.hoisted(() => ({
  record: vi.fn(() => Promise.resolve()),
  shape: vi.fn(() => Promise.resolve()),
}));

vi.mock("./amp-signer", async (importOriginal) => ({
  ...await importOriginal<typeof import("./amp-signer")>(),
  validateReceiveRecord: signerValidation.record,
  validateReceiveRecordShape: signerValidation.shape,
}));

import { protocolId, registrySchema, type Deployment, type PolicySnapshot, type ReceiveRecord } from "./domain";
import {
  TransferValidationError,
  estimateTransferFee,
  maxReceiveRecordBytes,
  parseReceiveRecordSource,
  parseTransferAmount,
  resolveAndValidateReceiveRecord,
  selectTransferFunding,
} from "./transfer-validation";
import type { WalletSyncSnapshot, WalletSyncUtxo } from "./wallet-sync";

const hash = (byte: string) => byte.repeat(64);
const profileId = `liquid-testnet:${hash("a")}`;

const deployment: Deployment = {
  schema: registrySchema,
  protocol: protocolId,
  network: "liquid-testnet",
  policyAsset: hash("1"),
  regulatedAsset: hash("2"),
  verifierAsset: hash("3"),
  verifierAssetAmount: 1,
  issuerPublicKey: hash("4"),
  deploymentSalt: hash("5"),
  genesisAnchor: `${hash("6")}:0`,
  asset: { name: "Regulated asset", ticker: "AMP", precision: 2 },
  issuedSupply: "100000",
  supplyMode: "fixed",
  reissuanceToken: null,
  reissuanceEntropy: null,
  userProgramHash: hash("7"),
  governanceProgramHash: hash("8"),
  contractBundleHash: hash("9"),
  deploymentId: hash("a"),
  confirmations: 2,
  activeAnchor: `${hash("b")}:0`,
  publication: "published",
};

const policy: PolicySnapshot = {
  schema: registrySchema,
  protocol: protocolId,
  deploymentId: deployment.deploymentId,
  sequence: 0,
  parentPolicyRoot: null,
  parentVerifierScriptHash: null,
  treeDepth: 4,
  setRoot: hash("c"),
  entryCount: 0,
  policyRoot: hash("d"),
  verifierProgramHash: hash("e"),
  verifierScriptPubkey: "51",
  entries: [],
};

const record: ReceiveRecord = {
  schema: registrySchema,
  protocol: protocolId,
  deploymentId: deployment.deploymentId,
  alias: "Recipient",
  ownerPublicKey: hash("f"),
  scriptPubkey: "51",
  confidentialAddress: `tlq1${"q".repeat(50)}`,
  blindingPublicKey: `02${hash("1")}`,
  proofAddress: `tlq1${"p".repeat(50)}`,
  bip322Signature: "signed-proof",
};

function holderUtxo(txByte: string, vout: number, amount: bigint, status: "confirmed" | "unconfirmed" = "confirmed"): WalletSyncUtxo {
  return {
    source: "holder",
    txid: hash(txByte),
    vout,
    transaction: "00",
    status,
    assetId: deployment.regulatedAsset,
    amount: amount.toString(),
    scriptPubkey: "51",
    assetConfidential: false,
    valueConfidential: false,
    holderKey: { derivationIndex: vout, ownerPublicKey: hash("f") },
  };
}

function feeUtxo(
  txByte: string,
  vout: number,
  amount: bigint,
  status: "confirmed" | "unconfirmed" = "confirmed",
  confidentiality: { asset?: boolean; value?: boolean } = {},
): WalletSyncUtxo {
  return {
    source: "wallet",
    txid: hash(txByte),
    vout,
    transaction: "00",
    status,
    assetId: deployment.policyAsset,
    amount: amount.toString(),
    scriptPubkey: "51",
    assetConfidential: confidentiality.asset ?? false,
    valueConfidential: confidentiality.value ?? false,
    walletKey: { branch: 0, index: vout },
  };
}

function snapshot(utxos: WalletSyncUtxo[]): WalletSyncSnapshot {
  return {
    version: 3,
    profileId,
    network: "liquid-testnet",
    discoveryProvider: "waterfalls-v4",
    scope: deployment.deploymentId,
    gapLimit: 10,
    scannedThrough: { external: 9, change: 9 },
    tipHeight: 100,
    tipHash: hash("b"),
    syncedAt: "2026-08-22T00:00:00.000Z",
    addresses: [],
    utxos,
  };
}

beforeEach(() => {
  signerValidation.record.mockReset().mockResolvedValue(undefined);
  signerValidation.shape.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());

describe("transfer amount validation", () => {
  it.each([
    ["", "required"],
    ["0", "positive"],
    ["-1", "signed"],
    ["+1", "signed"],
    ["1e3", "exponent"],
    ["1,000", "syntax"],
    ["1.234", "precision"],
    ["18446744073709551616", "overflow"],
  ])("rejects %j with %s", (value, code) => {
    expect(() => parseTransferAmount(value, 2)).toThrow(TransferValidationError);
    try { parseTransferAmount(value, 2); } catch (error) { expect(error).toMatchObject({ field: "amount", code }); }
  });

  it("parses exact base units without floating point", () => {
    expect(parseTransferAmount("90071992547409.91", 2)).toEqual({ normalized: "90071992547409.91", units: 9_007_199_254_740_991n });
  });
});

describe("ReceiveRecord validation", () => {
  it("rejects plain addresses, insecure links, malformed JSON, and unsupported versions", async () => {
    expect(() => parseReceiveRecordSource(`tlq1${"q".repeat(50)}`)).toThrow(/plain Liquid address/i);
    expect(() => parseReceiveRecordSource("http://example.test/record.json")).toThrow(/HTTPS/i);
    expect(() => parseReceiveRecordSource("{broken")).toThrow(/malformed/i);
    await expect(resolveAndValidateReceiveRecord(JSON.stringify({ ...record, protocol: "old" }), deployment)).rejects.toMatchObject({ field: "recipient", code: "version" });
    await expect(resolveAndValidateReceiveRecord(JSON.stringify({ ...record, deploymentId: hash("0") }), deployment)).rejects.toMatchObject({ field: "recipient", code: "deployment" });
  });

  it("performs shared shape and cryptographic checks for a valid record", async () => {
    await expect(resolveAndValidateReceiveRecord(JSON.stringify(record), deployment)).resolves.toEqual(record);
    expect(signerValidation.shape).toHaveBeenCalledWith(record);
    expect(signerValidation.record).toHaveBeenCalledOnce();

    signerValidation.record.mockRejectedValueOnce(new Error("wrong network proof"));
    await expect(resolveAndValidateReceiveRecord(JSON.stringify(record), deployment)).rejects.toMatchObject({ field: "recipient", code: "cryptographic-validation" });
  });

  it("bounds remote records and reports retryable request failures", async () => {
    const oversized = vi.fn(() => Promise.resolve(new Response("{}", { headers: { "content-length": "128001" } })));
    await expect(resolveAndValidateReceiveRecord("https://example.test/record.json", deployment, { request: oversized as typeof fetch })).rejects.toMatchObject({ code: "size" });
    const unavailable = vi.fn(() => Promise.resolve(new Response("unavailable", { status: 503 })));
    await expect(resolveAndValidateReceiveRecord("https://example.test/record.json", deployment, { request: unavailable as typeof fetch })).rejects.toMatchObject({ code: "fetch", retryable: true });

    const unannouncedOversized = vi.fn(() => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(maxReceiveRecordBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }))));
    await expect(resolveAndValidateReceiveRecord("https://example.test/record.json", deployment, { request: unannouncedOversized as typeof fetch })).rejects.toMatchObject({ code: "size" });
  });

  it("rejects redirects, omits ambient credentials and referrers, and times out stalled bodies", async () => {
    const direct = vi.fn(() => Promise.resolve(new Response(JSON.stringify(record))));
    await expect(resolveAndValidateReceiveRecord("https://example.test/record.json", deployment, { request: direct as typeof fetch })).resolves.toEqual(record);
    expect(direct).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }));

    const redirected = vi.fn(() => Promise.reject(new TypeError("redirect mode is set to error")));
    await expect(resolveAndValidateReceiveRecord("https://example.test/redirect", deployment, { request: redirected as typeof fetch })).rejects.toMatchObject({
      code: "fetch",
      message: expect.stringMatching(/Redirects are not accepted/i),
    });

    const followedResponse = new Response(JSON.stringify(record));
    Object.defineProperty(followedResponse, "redirected", { value: true });
    const silentlyFollowed = vi.fn(() => Promise.resolve(followedResponse));
    await expect(resolveAndValidateReceiveRecord("https://example.test/redirect", deployment, { request: silentlyFollowed as typeof fetch })).rejects.toMatchObject({
      code: "redirect",
      message: expect.stringMatching(/may not redirect/i),
    });

    vi.useFakeTimers();
    const stalled = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const timedOut = resolveAndValidateReceiveRecord("https://example.test/stalled", deployment, {
      request: stalled as typeof fetch,
      timeoutMs: 25,
    });
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ code: "timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(25);
    await timeoutAssertion;
  });
});

describe("transfer funding selection", () => {
  it("selects confirmed regulated and fee outputs deterministically and reports exact change", () => {
    const result = selectTransferFunding({
      snapshot: snapshot([holderUtxo("2", 1, 200n), holderUtxo("1", 0, 150n), holderUtxo("3", 2, 500n, "unconfirmed"), feeUtxo("4", 0, 5_000n)]),
      deployment,
      policy,
      profileId,
      amount: 250n,
    });
    expect(result.regulatedUtxos.map(({ txid }) => txid)).toEqual([hash("2"), hash("1")]);
    expect(result.regulatedChange).toBe(100n);
    expect(result.confirmedRegulated).toBe(350n);
    expect(result.pendingRegulated).toBe(500n);
    expect(result.feeUtxos).toHaveLength(1);
    expect(result.fee).toBeGreaterThanOrEqual(500n);
  });

  it("distinguishes pending balance, the ten-input limit, blacklist exclusion, and fee recovery", () => {
    expect(() => selectTransferFunding({ snapshot: snapshot([holderUtxo("1", 0, 100n), holderUtxo("2", 0, 100n, "unconfirmed"), feeUtxo("3", 0, 5_000n)]), deployment, policy, profileId, amount: 150n }))
      .toThrow(/wait for pending funds/i);

    const many = Array.from({ length: 11 }, (_, index) => holderUtxo((index + 1).toString(16), index, 1n));
    expect(() => selectTransferFunding({ snapshot: snapshot([...many, feeUtxo("f", 0, 5_000n)]), deployment, policy, profileId, amount: 11n }))
      .toThrow(/more than 10 regulated inputs/i);

    const blocked = holderUtxo("1", 0, 100n);
    expect(() => selectTransferFunding({ snapshot: snapshot([blocked, feeUtxo("2", 0, 5_000n)]), deployment, policy: { ...policy, entryCount: 1, entries: [{ txid: blocked.txid, vout: blocked.vout }] }, profileId, amount: 1n }))
      .toThrow(/confirmed spendable balance of 0 AMP\. 1 AMP is blacklisted and cannot be spent/i);

    expect(() => selectTransferFunding({ snapshot: snapshot([holderUtxo("1", 0, 100n), feeUtxo("2", 0, 3_000n, "unconfirmed")]), deployment, policy, profileId, amount: 50n }))
      .toThrow(/compatible L-BTC output is pending confirmation/i);
  });

  it("mirrors the signer's one-output fee selection and confidential-change headroom", () => {
    const fee = estimateTransferFee(1);
    const holder = holderUtxo("1", 0, 100n);
    expect(() => selectTransferFunding({
      snapshot: snapshot([holder, feeUtxo("2", 0, fee - 1n), feeUtxo("3", 0, fee - 1n)]),
      deployment,
      policy,
      profileId,
      amount: 50n,
    })).toThrow(/one compatible fee output/i);

    expect(() => selectTransferFunding({
      snapshot: snapshot([holder, feeUtxo("2", 0, fee, "confirmed", { asset: true })]),
      deployment,
      policy,
      profileId,
      amount: 50n,
    })).toThrow(/one compatible fee output/i);

    const assetConfidential = selectTransferFunding({
      snapshot: snapshot([holder, feeUtxo("2", 0, fee + 1n, "confirmed", { asset: true })]),
      deployment,
      policy,
      profileId,
      amount: 50n,
    });
    expect(assetConfidential.feeUtxos[0]).toMatchObject({ txid: hash("2"), vout: 0 });

    const selected = selectTransferFunding({
      snapshot: snapshot([
        holder,
        feeUtxo("2", 0, fee, "confirmed", { value: true }),
        feeUtxo("3", 0, fee + 1n, "confirmed", { value: true }),
        feeUtxo("4", 0, fee + 100n, "confirmed", { asset: true }),
      ]),
      deployment,
      policy,
      profileId,
      amount: 50n,
    });
    expect(selected.feeUtxos).toHaveLength(1);
    expect(selected.feeUtxos[0]).toMatchObject({ txid: hash("3"), vout: 0 });
  });

  it("fails closed for missing or cross-network wallet snapshots", () => {
    expect(() => selectTransferFunding({ snapshot: undefined, deployment, policy, profileId, amount: 1n })).toThrow(/balance is unavailable/i);
    expect(() => selectTransferFunding({ snapshot: { ...snapshot([]), profileId: `liquid-testnet:${hash("f")}` }, deployment, policy, profileId, amount: 1n })).toThrow(/another signer profile/i);
    expect(() => selectTransferFunding({ snapshot: { ...snapshot([]), network: "elements-regtest" }, deployment, policy, profileId, amount: 1n })).toThrow(/another network/i);
    expect(() => selectTransferFunding({ snapshot: { ...snapshot([]), scope: hash("f") }, deployment, policy, profileId, amount: 1n })).toThrow(/another deployment/i);
    expect(() => selectTransferFunding({ snapshot: snapshot([]), deployment, policy: { ...policy, deploymentId: hash("f") }, profileId, amount: 1n })).toThrow(/policy belongs to another deployment/i);
  });
});
