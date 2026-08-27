import { z } from "zod";

import {
  validateRecipientAddress,
  type SpendableUtxo,
} from "./amp-signer";
import {
  formatUnits,
  parseUnits,
  publicManifest,
  type Deployment,
  type PolicySnapshot,
} from "./domain";
import type { WalletSyncSnapshot, WalletSyncUtxo } from "./wallet-sync";

export const maxTransferInputs = 10;
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
  // Finalized signer fixtures measure 15,415 WU for one regulated input and roughly 787 WU
  // for each additional input. Round both upward, then mirror LWK's default 100 sats/kvB
  // calculation over Liquid's discounted transaction weight. Keep a 500-sat floor so small
  // model variance cannot turn a successfully reviewed transfer into a relay rejection.
  const estimatedWeight = 15_600n + BigInt(regulatedInputCount - 1) * 800n;
  const estimatedVsize = (estimatedWeight + 3n) / 4n;
  const lwkDefaultFee = (estimatedVsize * 100n + 999n) / 1_000n;
  const fee = lwkDefaultFee < minimumTransferFee ? minimumTransferFee : lwkDefaultFee;
  if (fee < minimumTransferFee || fee > maximumTransferFee) {
    throw new TransferValidationError("context", "fee-bounds", "Network fee is outside the supported test transaction bounds.");
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
  const blacklistedRegulated = total(blacklisted);

  if (amount > selectableRegulated) {
    if (amount <= confirmedRegulated) {
      throw new TransferValidationError("amount", "input-limit", `This amount needs more than ${maxTransferInputs} regulated inputs. Choose a smaller amount or consolidate outputs first.`);
    }
    if (amount <= confirmedRegulated + pendingRegulated) {
      throw new TransferValidationError("amount", "pending-balance", `Only ${formatUnits(confirmedRegulated, deployment.asset.precision)} ${deployment.asset.ticker} is confirmed; wait for pending funds and refresh.`);
    }
    const blacklistDetail = blacklistedRegulated > 0n
      ? ` ${formatUnits(blacklistedRegulated, deployment.asset.precision)} ${deployment.asset.ticker} is blacklisted and cannot be spent.`
      : "";
    throw new TransferValidationError("amount", "insufficient-balance", `Amount exceeds the confirmed spendable balance of ${formatUnits(confirmedRegulated, deployment.asset.precision)} ${deployment.asset.ticker}.${blacklistDetail}`);
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
        ? " DAMP v0.1 needs one compatible fee output; smaller outputs cannot be combined in this transaction. Request another test output or consolidate them first."
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

export async function resolveAndValidateRecipientAddress(value: string, deployment: Deployment) {
  const address = value.trim();
  if (!address) {
    throw new TransferValidationError("recipient", "required", "Paste the recipient's confidential DAMP address.");
  }
  try {
    const ownerPublicKey = await validateRecipientAddress(publicManifest(deployment), address);
    return { confidentialAddress: address, ownerPublicKey };
  } catch (error) {
    throw new TransferValidationError(
      "recipient",
      "address",
      `Recipient address is invalid or incompatible with the selected deployment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
