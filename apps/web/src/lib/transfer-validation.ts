import { z } from "zod";

import {
  validateReceiveRecord,
  validateReceiveRecordShape,
  type SpendableUtxo,
} from "./amp-signer";
import {
  formatUnits,
  parseUnits,
  protocolId,
  publicManifest,
  receiveRecordSchema,
  registrySchema,
  type Deployment,
  type PolicySnapshot,
  type ReceiveRecord,
} from "./domain";
import type { WalletSyncSnapshot, WalletSyncUtxo } from "./wallet-sync";

export const maxTransferInputs = 10;
export const maxReceiveRecordBytes = 128_000;
export const receiveRecordRequestTimeoutMs = 15_000;
export const minimumTransferFee = 500n;
export const maximumTransferFee = 100_000n;
const unsigned64Max = (1n << 64n) - 1n;

export class TransferValidationError extends Error {
  constructor(
    readonly field: "recipient" | "amount" | "context",
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TransferValidationError";
  }
}

export function parseTransferAmount(value: string, precision: number) {
  const normalized = value.trim();
  if (!normalized) throw new TransferValidationError("amount", "required", "Enter an amount.");
  if (/[eE]/.test(normalized)) {
    throw new TransferValidationError("amount", "exponent", "Enter a decimal amount without exponent notation.");
  }
  if (normalized.startsWith("-") || normalized.startsWith("+")) {
    throw new TransferValidationError("amount", "signed", "Enter an amount greater than zero without a sign.");
  }
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized)) {
    throw new TransferValidationError("amount", "syntax", "Enter a decimal amount using digits and at most one decimal point.");
  }
  const fractional = normalized.split(".")[1] ?? "";
  if (fractional.length > precision) {
    throw new TransferValidationError("amount", "precision", `This asset supports at most ${precision} decimal${precision === 1 ? "" : "s"}.`);
  }
  const units = parseUnits(normalized, precision);
  if (units <= 0n) throw new TransferValidationError("amount", "positive", "Enter an amount greater than zero.");
  if (units > unsigned64Max) throw new TransferValidationError("amount", "overflow", "Amount exceeds the supported base-unit range.");
  return { normalized, units };
}

export function estimateTransferFee(regulatedInputCount: number) {
  if (!Number.isSafeInteger(regulatedInputCount) || regulatedInputCount < 1 || regulatedInputCount > maxTransferInputs) {
    throw new TransferValidationError("context", "input-count", `Transfers require between 1 and ${maxTransferInputs} regulated inputs.`);
  }
  const estimatedWeight = 650n + BigInt(regulatedInputCount) * 180n + 5n * 100n;
  const fee = (estimatedWeight * 125n + 99n) / 100n;
  if (fee < minimumTransferFee || fee > maximumTransferFee) {
    throw new TransferValidationError("context", "fee-bounds", "Estimated fee is outside the supported test transaction bounds.");
  }
  return fee;
}

function compareOutpoints(left: WalletSyncUtxo, right: WalletSyncUtxo) {
  return left.txid.localeCompare(right.txid) || left.vout - right.vout;
}

function compareByAmountThenOutpoint(left: WalletSyncUtxo, right: WalletSyncUtxo) {
  const amount = BigInt(left.amount) - BigInt(right.amount);
  return amount < 0n ? -1 : amount > 0n ? 1 : compareOutpoints(left, right);
}

function spendable(utxo: WalletSyncUtxo): SpendableUtxo {
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    transaction: utxo.transaction,
    spendable: true,
    ...(utxo.source === "wallet" ? { walletKey: utxo.walletKey } : { holderKey: utxo.holderKey }),
  };
}

function total(utxos: WalletSyncUtxo[]) {
  return utxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
}

export type TransferFundingSelection = {
  regulatedUtxos: SpendableUtxo[];
  feeUtxos: SpendableUtxo[];
  amount: bigint;
  fee: bigint;
  regulatedChange: bigint;
  confirmedRegulated: bigint;
  pendingRegulated: bigint;
  selectableRegulated: bigint;
  confirmedFees: bigint;
  pendingFees: bigint;
  blacklistedConfirmed: bigint;
};

export function selectTransferFunding(input: {
  snapshot?: WalletSyncSnapshot;
  deployment: Deployment;
  policy: PolicySnapshot;
  profileId: string;
  amount: bigint;
}): TransferFundingSelection {
  const { snapshot, deployment, policy, profileId, amount } = input;
  if (amount <= 0n || amount > unsigned64Max) {
    throw new TransferValidationError("amount", "range", "Transfer amount must be within the positive unsigned base-unit range.");
  }
  if (!snapshot) {
    throw new TransferValidationError("context", "wallet-unavailable", "Wallet balance is unavailable. Refresh synchronization before reviewing a transfer.", true);
  }
  if (snapshot.profileId !== profileId) {
    throw new TransferValidationError("context", "wallet-profile", "The synchronized wallet belongs to another signer profile. Switch profiles and refresh.");
  }
  if (snapshot.network !== deployment.network) {
    throw new TransferValidationError("context", "wallet-network", "The synchronized wallet belongs to another network. Switch profiles and refresh.");
  }
  if (snapshot.scope !== deployment.deploymentId) {
    throw new TransferValidationError("context", "wallet-deployment", "The synchronized wallet belongs to another deployment. Refresh the selected deployment wallet.");
  }
  if (policy.deploymentId !== deployment.deploymentId) {
    throw new TransferValidationError("context", "policy-deployment", "The resolved policy belongs to another deployment. Recheck the live anchor.");
  }
  const blacklist = new Set(policy.entries.map((entry) => `${entry.txid}:${entry.vout}`));
  const regulated = snapshot.utxos.filter((utxo) => utxo.source === "holder" && utxo.assetId === deployment.regulatedAsset);
  const confirmed = regulated.filter((utxo) => utxo.status === "confirmed");
  const pending = regulated.filter((utxo) => utxo.status === "unconfirmed");
  const blacklisted = confirmed.filter((utxo) => blacklist.has(`${utxo.txid}:${utxo.vout}`));
  const eligible = confirmed
    .filter((utxo) => !blacklist.has(`${utxo.txid}:${utxo.vout}`))
    .sort(compareByAmountThenOutpoint);
  const single = eligible.find((utxo) => BigInt(utxo.amount) >= amount);
  const selectable = single
    ? [single]
    : [...eligible].reverse().slice(0, maxTransferInputs);
  const selectableRegulated = total(selectable);
  const confirmedRegulated = total(eligible);
  const pendingRegulated = total(pending);

  if (amount > selectableRegulated) {
    if (amount <= confirmedRegulated) {
      throw new TransferValidationError("amount", "input-limit", `This amount needs more than ${maxTransferInputs} regulated inputs. Choose a smaller amount or consolidate outputs first.`);
    }
    if (amount <= confirmedRegulated + pendingRegulated) {
      throw new TransferValidationError("amount", "pending-balance", `Only ${formatUnits(confirmedRegulated, deployment.asset.precision)} ${deployment.asset.ticker} is confirmed; wait for pending funds and refresh.`);
    }
    throw new TransferValidationError("amount", "insufficient-balance", `Amount exceeds the confirmed spendable balance of ${formatUnits(confirmedRegulated, deployment.asset.precision)} ${deployment.asset.ticker}.`);
  }

  const chosen: WalletSyncUtxo[] = [];
  let chosenAmount = 0n;
  for (const utxo of selectable) {
    chosen.push(utxo);
    chosenAmount += BigInt(utxo.amount);
    if (chosenAmount >= amount) break;
  }
  const fee = estimateTransferFee(chosen.length);
  const compatibleFeeOutput = (utxo: WalletSyncUtxo) => {
    const needsConfidentialChange = utxo.assetConfidential || utxo.valueConfidential;
    const required = fee + (needsConfidentialChange ? 1n : 0n);
    return BigInt(utxo.amount) >= required;
  };
  const confirmedFeeCandidates = snapshot.utxos
    .filter((utxo) => utxo.source === "wallet" && utxo.assetId === deployment.policyAsset && utxo.status === "confirmed")
    .sort(compareByAmountThenOutpoint);
  const pendingFeeCandidates = snapshot.utxos
    .filter((utxo) => utxo.source === "wallet" && utxo.assetId === deployment.policyAsset && utxo.status === "unconfirmed")
    .sort(compareByAmountThenOutpoint);
  // The v0.1 verifier budget admits one ordinary fee input. Mirror the Rust
  // signer's smallest-sufficient selection so review cannot promise that a sum
  // of individually insufficient outputs is spendable.
  const feeOutput = confirmedFeeCandidates.find(compatibleFeeOutput);
  const pendingFees = total(pendingFeeCandidates);
  if (!feeOutput) {
    const pendingHint = pendingFeeCandidates.some(compatibleFeeOutput)
      ? " A compatible L-BTC output is pending confirmation."
      : total(confirmedFeeCandidates) >= fee
        ? " AMP v0.1 needs one compatible fee output; smaller outputs cannot be combined in this transaction. Request another test output or consolidate them first."
        : deployment.network === "liquid-testnet"
          ? " Request Liquid testnet funds, then refresh the wallet."
          : " Fund one signer wallet output from the local Elements node, then refresh the wallet.";
    throw new TransferValidationError("context", "insufficient-fee", `No confirmed L-BTC output can pay the estimated ${fee} satoshi fee.${pendingHint}`, true);
  }
  const confirmedFees = BigInt(feeOutput.amount);

  return {
    regulatedUtxos: chosen.map(spendable),
    feeUtxos: [spendable(feeOutput)],
    amount,
    fee,
    regulatedChange: chosenAmount - amount,
    confirmedRegulated,
    pendingRegulated,
    selectableRegulated,
    confirmedFees,
    pendingFees,
    blacklistedConfirmed: total(blacklisted),
  };
}

function plainAddressMessage() {
  return "Paste a signed AMP ReceiveRecord JSON or HTTPS URL. A plain Liquid address does not prove the holder covenant or deployment binding.";
}

export function parseReceiveRecordSource(value: string): { json?: unknown; url?: URL } {
  const normalized = value.trim();
  if (!normalized) throw new TransferValidationError("recipient", "required", "Paste a signed AMP ReceiveRecord JSON or HTTPS URL.");
  if (normalized.startsWith("{")) {
    try {
      return { json: JSON.parse(normalized) };
    } catch {
      throw new TransferValidationError("recipient", "json", "ReceiveRecord JSON is malformed. Copy the complete record from the recipient's Receive screen.");
    }
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TransferValidationError("recipient", "plain-address", plainAddressMessage());
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TransferValidationError("recipient", "url", "ReceiveRecord links must use HTTPS and must not contain embedded credentials.");
  }
  return { url };
}

function parseReceiveRecord(raw: unknown, deployment: Deployment) {
  if (raw && typeof raw === "object") {
    const version = raw as { schema?: unknown; protocol?: unknown };
    if (version.schema !== registrySchema || version.protocol !== protocolId) {
      throw new TransferValidationError("recipient", "version", "Unsupported ReceiveRecord version or protocol. Ask the recipient to generate a current Simplicity AMP v0.1 record.");
    }
  }
  let record: ReceiveRecord;
  try {
    record = receiveRecordSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new TransferValidationError("recipient", "shape", `ReceiveRecord fields are invalid: ${error.issues[0]?.message ?? "invalid data"}.`);
    }
    throw error;
  }
  if (record.deploymentId !== deployment.deploymentId) {
    throw new TransferValidationError("recipient", "deployment", "ReceiveRecord belongs to another deployment, asset, or genesis anchor.");
  }
  return record;
}

export async function resolveAndValidateReceiveRecord(
  value: string,
  deployment: Deployment,
  options: { request?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const source = parseReceiveRecordSource(value);
  let raw = source.json;
  if (source.url) {
    const requestGuard = receiveRecordRequestGuard(
      options.signal,
      options.timeoutMs ?? receiveRecordRequestTimeoutMs,
    );
    try {
      const response = await (options.request ?? fetch)(source.url, {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: requestGuard.signal,
      });
      // `redirect: "error"` is enforced by native fetch. Keep the response-side
      // check as well so injected transports, service-worker wrappers, or test
      // adapters cannot silently weaken the direct-origin requirement.
      if (response.redirected) {
        throw new TransferValidationError(
          "recipient",
          "redirect",
          "ReceiveRecord links may not redirect. Use the final direct HTTPS link or paste the JSON.",
        );
      }
      if (!response.ok) {
        throw new TransferValidationError("recipient", "fetch", `ReceiveRecord request failed (${response.status}). Retry the link or paste the JSON directly.`, true);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxReceiveRecordBytes) {
        throw new TransferValidationError("recipient", "size", "ReceiveRecord response is too large.");
      }
      const body = await readBoundedResponseText(response, maxReceiveRecordBytes);
      try {
        raw = JSON.parse(body);
      } catch {
        throw new TransferValidationError("recipient", "json", "ReceiveRecord URL did not return valid JSON.");
      }
    } catch (error) {
      if (requestGuard.timedOut()) {
        throw new TransferValidationError("recipient", "timeout", "ReceiveRecord request timed out. Paste the JSON directly or retry a direct HTTPS link.", true);
      }
      if (options.signal?.aborted || error instanceof TransferValidationError) throw error;
      throw new TransferValidationError(
        "recipient",
        "fetch",
        "ReceiveRecord request could not be completed. Redirects are not accepted; use a direct HTTPS link or paste the JSON.",
        true,
      );
    } finally {
      requestGuard.finish();
    }
  }
  const record = parseReceiveRecord(raw, deployment);
  try {
    await validateReceiveRecordShape(record);
    await validateReceiveRecord(publicManifest(deployment), record);
  } catch (error) {
    throw new TransferValidationError(
      "recipient",
      "cryptographic-validation",
      `ReceiveRecord checksum, network, holder key, address, or deployment proof is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return record;
}

function receiveRecordRequestGuard(externalSignal: AbortSignal | undefined, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("ReceiveRecord request timeout must be between 1 and 60000 milliseconds.");
  }
  const controller = new AbortController();
  let timeoutReached = false;
  const relayAbort = () => controller.abort();
  if (externalSignal?.aborted) relayAbort();
  else externalSignal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    finish: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", relayAbort);
    },
  };
}

async function readBoundedResponseText(response: Response, maximumBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maximumBytes) {
      throw new TransferValidationError("recipient", "size", "ReceiveRecord response is too large.");
    }
    return body;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel("ReceiveRecord response exceeded the size limit.");
        throw new TransferValidationError("recipient", "size", "ReceiveRecord response is too large.");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    if (error instanceof TransferValidationError) throw error;
    throw new TransferValidationError("recipient", "encoding", "ReceiveRecord response is not valid UTF-8 JSON.");
  } finally {
    reader.releaseLock();
  }
}
