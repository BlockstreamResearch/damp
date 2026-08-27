import { ExternalLink, Fuel, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  signerSessionRevision,
  signerSnapshot,
  splitFunding,
  type DerivedWalletAddress,
  type SpendableUtxo,
  type SplitFundingResult,
  type SignerNetwork,
} from "../lib/amp-signer";
import { broadcastTransaction } from "../lib/chain-wallet";
import { formatUnits, userFacingError } from "../lib/domain";
import { isRetryableEsploraRequest } from "../lib/esplora";
import { transactionExplorerUrl } from "../lib/operation-receipt";
import { setSignerOperationPending } from "../lib/signer-operation-state";
import { getDraft, putDraft } from "../lib/store";

const SPLIT_FEE = 500n;

const receiptSchema = z.object({
  schema: z.literal("simplicity-amp-funding-split-receipt-v1"),
  signerProfileId: z.string(),
  network: z.enum(["liquid-testnet", "elements-regtest"]),
  sourceOutpoint: z.string().regex(/^[0-9a-f]{64}:[0-9]+$/),
  sourceAmount: z.string().regex(/^[1-9][0-9]*$/),
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  transaction: z.string().regex(/^(?:[0-9a-f]{2})+$/),
  fee: z.literal("500"),
  outputs: z.array(z.object({ vout: z.number().int().min(0).max(1), amount: z.string().regex(/^[1-9][0-9]*$/) }).strict()).length(2),
  phase: z.enum(["signed", "broadcast"]),
  createdAt: z.string().datetime(),
}).strict();
type SplitReceipt = z.infer<typeof receiptSchema>;
type Phase = "preview" | "signing" | "broadcasting" | "broadcast-retry" | "confirming" | "done" | "obsolete" | "failed";

function receiptName(profileId: string, network: SignerNetwork) {
  return `funding-split:${profileId}:${network}`;
}

function retryableBroadcast(error: unknown) {
  if (isRetryableEsploraRequest(error)) return true;
  const message = userFacingError(error);
  return /\((?:404|408|425|429|5\d\d)\)/.test(message) || /network|fetch|timeout/i.test(message);
}

export function FundingSplitDialog({
  network,
  policyAsset,
  profileId,
  candidate,
  candidateAmount,
  destinations,
  snapshotStatuses,
  disabled,
  refreshFunding,
  onNotice,
}: {
  network: SignerNetwork;
  policyAsset: string;
  profileId: string;
  candidate?: SpendableUtxo;
  candidateAmount?: string;
  destinations: DerivedWalletAddress[];
  snapshotStatuses: Array<{ txid: string; vout: number; status: "confirmed" | "unconfirmed" | "spent" | "orphaned" }>;
  disabled?: boolean;
  refreshFunding: () => Promise<{ confirmed: SpendableUtxo[]; pending: number }>;
  onNotice?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("preview");
  const [receipt, setReceipt] = useState<SplitReceipt>();
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const guard = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const busy = phase === "signing" || phase === "broadcasting";
  const sourceAmount = BigInt(candidateAmount ?? receipt?.sourceAmount ?? "0");
  const spendable = sourceAmount - SPLIT_FEE;
  const previewAmounts = [spendable / 2n, spendable - spendable / 2n];
  const key = receiptName(profileId, network);

  useEffect(() => {
    let current = true;
    setLoaded(false);
    void getDraft<unknown>("setup", key).then((stored) => {
      if (!current) return;
      const restored = stored ? receiptSchema.parse(stored) : undefined;
      if (restored && (restored.signerProfileId !== profileId || restored.network !== network)) {
        throw new Error("The saved split belongs to another signer or network.");
      }
      setReceipt(restored);
      setPhase(restored?.phase === "broadcast" ? "confirming" : restored ? "broadcast-retry" : "preview");
      setLoaded(true);
    }).catch((loadError) => {
      if (!current) return;
      setError(`Could not restore the prepared split: ${userFacingError(loadError)}`);
      setPhase("failed");
      setLoaded(true);
    });
    return () => { current = false; };
  }, [key]);

  useEffect(() => {
    const operationKey = `funding-split:${profileId}:${network}`;
    setSignerOperationPending(operationKey, busy);
    return () => setSignerOperationPending(operationKey, false);
  }, [busy, network, profileId]);

  useEffect(() => {
    if (!receipt || receipt.phase !== "broadcast") return;
    const outputs = receipt.outputs.map((output) => snapshotStatuses.find((utxo) => utxo.txid === receipt.txid && utxo.vout === output.vout));
    if (outputs.every((output) => output?.status === "confirmed")) setPhase("done");
    else if (outputs.some((output) => output?.status === "orphaned")) {
      setError("The split transaction was replaced or reorged. Refresh funding and start again.");
      setPhase("failed");
    } else setPhase("confirming");
  }, [receipt, snapshotStatuses]);

  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])");
    (first ?? panelRef.current)?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const firstFocusable = focusable[0]!;
      const lastFocusable = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === firstFocusable || !panel.contains(document.activeElement))) {
        event.preventDefault(); lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault(); firstFocusable.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [busy, open]);

  async function persist(next: SplitReceipt | undefined) {
    setReceipt(next);
    await putDraft("setup", key, next ?? null);
  }

  function validateResult(result: SplitFundingResult) {
    if (!candidate || !candidateAmount) throw new Error("The reviewed split source is no longer available.");
    if (result.fee !== "500" || !/^[0-9a-f]{64}$/.test(result.txid)) throw new Error("Signer returned an invalid split transaction summary.");
    if (result.sourceTxid !== candidate.txid || result.sourceVout !== candidate.vout || result.sourceAmount !== candidateAmount) {
      throw new Error("Signer split a different funding output than the one reviewed.");
    }
    if (result.outputs.length !== 2) throw new Error("Signer returned an invalid split output count.");
    const outputTotal = result.outputs.reduce((total, output) => total + BigInt(output.amount), 0n);
    if (outputTotal + BigInt(result.fee) !== sourceAmount) throw new Error("Signer split values do not conserve the reviewed source amount.");
    if (result.outputs.some((output, index) => output.vout !== index || output.confidentialAddress !== destinations[index]?.confidentialAddress)) {
      throw new Error("Signer returned an unexpected split destination.");
    }
  }

  async function broadcastPrepared(prepared: SplitReceipt) {
    setPhase("broadcasting");
    setError(undefined);
    try {
      const txid = await broadcastTransaction({ network }, prepared.transaction);
      if (txid !== prepared.txid) throw new Error("Esplora returned a different split transaction ID.");
      const broadcast = receiptSchema.parse({ ...prepared, phase: "broadcast" });
      await persist(broadcast);
      setPhase("confirming");
      await refreshFunding();
      onNotice?.("Split transaction broadcast. Waiting for one confirmation.");
    } catch (broadcastError) {
      const detail = userFacingError(broadcastError);
      if (/already (?:in (?:the )?mempool|in (?:the )?block ?chain|known)|txn-already-known/i.test(detail)) {
        const broadcast = receiptSchema.parse({ ...prepared, phase: "broadcast" });
        await persist(broadcast);
        setPhase("confirming");
        await refreshFunding();
        onNotice?.("Split transaction is already known. Waiting for one confirmation.");
        return;
      }
      setError(retryableBroadcast(broadcastError)
        ? "Broadcast did not complete. Retry sends the identical signed transaction — it cannot pay the fee twice."
        : detail);
      setPhase(retryableBroadcast(broadcastError) ? "broadcast-retry" : "failed");
    } finally {
      guard.current = false;
    }
  }

  async function signAndBroadcast() {
    if (guard.current || receipt) return;
    guard.current = true;
    setPhase("signing");
    setError(undefined);
    try {
      if (!candidate || !candidateAmount || destinations.length !== 2) throw new Error("Refresh the funding wallet before splitting.");
      const revision = signerSessionRevision();
      const refreshed = await refreshFunding();
      if (refreshed.confirmed.length >= 2) { setPhase("obsolete"); guard.current = false; return; }
      if (refreshed.pending > 0) {
        setError("Another funding output is already awaiting confirmation. Wait for it instead of splitting.");
        setPhase("obsolete");
        guard.current = false;
        return;
      }
      const source = refreshed.confirmed[0];
      if (!source || source.txid !== candidate.txid || source.vout !== candidate.vout) {
        setError("Funding changed while preparing the split. Review the updated amounts.");
        setPhase("preview");
        guard.current = false;
        return;
      }
      if (signerSessionRevision() !== revision || signerSnapshot().profileId !== profileId) {
        throw new Error("The active signer profile changed while preparing the split. Review again.");
      }
      const result = await splitFunding({ network, policyAsset, sourceUtxos: refreshed.confirmed, fee: "500" });
      validateResult(result);
      const prepared = receiptSchema.parse({
        schema: "simplicity-amp-funding-split-receipt-v1",
        signerProfileId: profileId,
        network,
        sourceOutpoint: `${candidate.txid}:${candidate.vout}`,
        sourceAmount: candidateAmount,
        txid: result.txid,
        transaction: result.transaction,
        fee: "500",
        outputs: result.outputs.map(({ vout, amount }) => ({ vout, amount })),
        phase: "signed",
        createdAt: new Date().toISOString(),
      });
      await persist(prepared);
      await broadcastPrepared(prepared);
    } catch (signError) {
      const detail = userFacingError(signError);
      setError(detail.includes("blinding") ? `${detail} Signing uses fresh randomness — try again.` : detail);
      setPhase("preview");
      guard.current = false;
    }
  }

  async function retryBroadcast() {
    if (!receipt || guard.current) return;
    guard.current = true;
    await broadcastPrepared(receipt);
  }

  async function discard() {
    await persist(undefined);
    guard.current = false;
    setError(undefined);
    setPhase("preview");
  }

  async function complete() {
    await discard();
    setOpen(false);
    triggerRef.current?.focus();
    onNotice?.("Two confirmed funding outputs are ready. Continue to issuance review.");
  }

  const explorer = receipt ? transactionExplorerUrl(network, receipt.txid) : undefined;
  if (loaded && !candidate && !receipt) return null;
  const [sourceTxid = "", sourceVout = "0"] = (receipt?.sourceOutpoint ?? (candidate ? `${candidate.txid}:${candidate.vout}` : ":0")).split(":");
  return (
    <div className="funding-split">
      <div className="funding-split-callout">
        <div><Fuel size={18} /><span><strong>Required next step: split the single confirmed output</strong><small>Asset issuance cannot continue with one input. Review and broadcast this one-time wallet split to create the two distinct inputs it requires.</small></span></div>
        <button ref={triggerRef} className="button issuer-primary" type="button" disabled={disabled || !loaded} aria-haspopup="dialog" aria-expanded={open} aria-controls="funding-split-dialog" onClick={() => setOpen(true)}>{receipt ? "View split status" : "Split this output into two"}</button>
      </div>
      {open && <div className="dialog-backdrop" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) { setOpen(false); triggerRef.current?.focus(); } }}>
        <div ref={panelRef} id="funding-split-dialog" className="funding-split-dialog" role="dialog" aria-modal="true" aria-labelledby="funding-split-title" tabIndex={-1}>
          <div className="dialog-heading"><div><small>Wallet funding</small><h2 id="funding-split-title">Split funding for issuance</h2></div>{!busy && <button className="icon-button" type="button" aria-label="Close split funding" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><X size={17} /></button>}</div>
          {phase === "preview" && <><p>Asset issuance derives its asset IDs from two distinct inputs. This wallet-only transaction turns your single confirmed output into two; no second faucet request is needed.</p><div className="review-stack"><div className="review-row"><span>Source output</span><strong>{sourceTxid.slice(0, 10)}…:{sourceVout} · {formatUnits(sourceAmount, 8)} L-BTC ({sourceAmount.toString()} sats)</strong></div><div className="review-row"><span>Network fee</span><strong>0.000005 L-BTC · 500 sats</strong></div><div className="review-row"><span>New output 1</span><strong>{formatUnits(previewAmounts[0], 8)} L-BTC · {previewAmounts[0].toString()} sats</strong></div><div className="review-row"><span>New output 2</span><strong>{formatUnits(previewAmounts[1], 8)} L-BTC · {previewAmounts[1].toString()} sats</strong></div><div className="review-row"><span>Destination</span><strong>Your two derived funding addresses</strong></div></div><p className="split-warning"><strong>Broadcasting is irreversible.</strong> The 500-satoshi fee is spent even if you later abandon issuance.</p></>}
          {phase === "signing" && <p role="status" aria-live="polite">Signing the reviewed split…</p>}
          {phase === "broadcasting" && <p role="status" aria-live="polite">Broadcasting the signed split…</p>}
          {phase === "confirming" && <p role="status" aria-live="polite">{network === "liquid-testnet" ? "Waiting for one Liquid confirmation… the two new outputs update automatically." : "Waiting for confirmation. Mine a block on the local Elements node."}</p>}
          {phase === "done" && <p role="status" aria-live="polite">Two confirmed funding outputs are ready. Continue to issuance review.</p>}
          {phase === "obsolete" && <p role="status">{error ?? "Funding already has two confirmed outputs. Close this dialog and review the issuance."}</p>}
          {error && phase !== "obsolete" && <p className="field-error" role="alert">{error}</p>}
          {explorer && (phase === "confirming" || phase === "done") && <a className="text-link" href={explorer} target="_blank" rel="noreferrer">View split transaction <ExternalLink size={13} /></a>}
          <div className="review-buttons">
            {phase === "preview" && <button className="button issuer-primary" type="button" aria-busy={busy} onClick={() => void signAndBroadcast()}>Sign and broadcast split</button>}
            {phase === "broadcast-retry" && <><button className="button secondary" type="button" onClick={() => void discard()}>Discard and start over</button><button className="button issuer-primary" type="button" onClick={() => void retryBroadcast()}>Retry broadcast</button></>}
            {phase === "failed" && <button className="button secondary" type="button" onClick={() => void discard()}>Discard and start over</button>}
            {phase === "done" && <button className="button issuer-primary" type="button" onClick={() => void complete()}>Continue to issuance review</button>}
            {phase === "obsolete" && <button className="button issuer-primary" type="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>{error ? "Close and wait" : "Close and review issuance"}</button>}
          </div>
        </div>
      </div>}
    </div>
  );
}
