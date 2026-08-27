import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signerValidation = vi.hoisted(() => ({
  address: vi.fn(() => Promise.resolve("ff".repeat(32))),
}));

vi.mock("./amp-signer", async (importOriginal) => ({
  ...await importOriginal<typeof import("./amp-signer")>(),
  validateRecipientAddress: signerValidation.address,
}));

import { protocolId, registrySchema, type Deployment, type PolicySnapshot } from "./domain";
import {
  TransferValidationError,
  estimateTransferFee,
  parseTransferAmount,
  resolveAndValidateRecipientAddress,
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

const recipientAddress = `tlq1${"q".repeat(50)}`;

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
  signerValidation.address.mockReset().mockResolvedValue(hash("f"));
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

describe("recipient address validation", () => {
  it("requires a confidential holder address", async () => {
    await expect(resolveAndValidateRecipientAddress("", deployment)).rejects.toMatchObject({ field: "recipient", code: "required" });
  });

  it("returns the address and signer-validated covenant owner", async () => {
    await expect(resolveAndValidateRecipientAddress(`  ${recipientAddress}  `, deployment)).resolves.toEqual({
      confidentialAddress: recipientAddress,
      ownerPublicKey: hash("f"),
    });
    expect(signerValidation.address).toHaveBeenCalledWith(expect.not.objectContaining({ deploymentId: expect.anything() }), recipientAddress);
  });

  it("reports malformed, unconfidential, wrong-network, and incompatible addresses", async () => {
    for (const message of ["recipient is not a valid Elements address", "recipient address must be confidential", "recipient address network mismatch", "not a holder address for the selected deployment"]) {
      signerValidation.address.mockRejectedValueOnce(new Error(message));
      await expect(resolveAndValidateRecipientAddress(recipientAddress, deployment)).rejects.toMatchObject({
        field: "recipient",
        code: "address",
        message: expect.stringContaining(message),
      });
    }
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

  it("prices the conservative finalized shape at LWK's default fee rate", () => {
    expect(estimateTransferFee(1)).toBe(500n);
    expect(estimateTransferFee(6)).toBe(500n);
    expect(estimateTransferFee(10)).toBe(570n);
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
