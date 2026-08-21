import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { QRCodeSVG } from "qrcode.react";
import { ArrowRight, Check, Copy, ExternalLink, EyeOff, Fuel, Info, Radio, RefreshCw, Send, ShieldCheck, Upload, WalletCards } from "lucide-react";

import {
  AppShell,
  BackLink,
  Panel,
  Pill,
  SafetyNote,
  SectionHeading,
  TechnicalDetails,
  VerifiedLabel,
} from "../components/ui";
import { OperationReceiptPanel } from "../components/operation-receipt";
import {
  signTransfer,
  signerSnapshot,
  subscribeSigner,
  validateReceiveRecord,
  validateReceiveRecordShape,
} from "../lib/amp-signer";
import {
  broadcastTransaction,
  liveAnchorUtxo,
} from "../lib/chain-wallet";
import { deploymentQueryKeys, useActiveDeployment } from "../lib/deployments";
import {
  formatUnits,
  networkLabel,
  parseUnits,
  publicationLabel,
  publicManifest,
  receiveRecordSchema,
  requireDeployment,
  requirePublishedDeployment,
  shortHash,
  supplyModeLabel,
  userFacingError,
  type Deployment,
  type ReceiveRecord,
} from "../lib/domain";
import {
  persistPublicDeploymentImport,
  validatePublicDeploymentImport,
} from "../lib/deployment-import";
import { esploraUrlForDeployment, requireFreshAnchor, traverseLiveAnchor } from "../lib/esplora";
import { liquidTestnetFaucetUrl } from "../lib/faucet";
import { resolvePolicySnapshot } from "../lib/policy-registry";
import { sendSchema, type SendForm } from "../lib/form-schemas";
import { useDeploymentWalletSync, walletSyncPresentation, walletSyncQueryKeys } from "../lib/wallet-query";
import {
  createOperationReceipt,
  dismissOperationReceipt,
  finishOperation,
  loadOperationReceipt,
  operationReceiptQueryKey,
  saveOperationReceipt,
  tryBeginOperation,
} from "../lib/operation-receipt";
import { setSignerOperationPending } from "../lib/signer-operation-state";
import {
  assetBalances,
  ensureSignerReceiveRecord,
  feeFundingState,
  nextFundingAddress,
  selectSpendableUtxos,
  synchronizeDeploymentWallet,
  type AssetBalance,
} from "../lib/wallet-sync";

export function WalletDashboard() {
  const deployment = useActiveDeployment();
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const signerMatchesDeployment = !deployment.data || signer.network === deployment.data.network;
  const wallet = useDeploymentWalletSync(
    deployment.data,
    signer.connected && signerMatchesDeployment ? signer.profileId : undefined,
  );
  const [feeMessage, setFeeMessage] = useState<string>();
  const snapshot = wallet.data?.snapshot;
  const balances = useMemo(() => assetBalances(snapshot), [snapshot]);
  const regulated = balances.find((balance) => balance.assetId === deployment.data?.regulatedAsset);
  const syncError = wallet.data?.syncError ?? (wallet.error instanceof Error ? wallet.error.message : undefined);
  const networkError = deployment.data && signer.connected && signer.network !== deployment.data.network
    ? `Reconnect the AMP signer for ${networkLabel(deployment.data.network)}.`
    : undefined;
  const presentation = walletSyncPresentation({
    connected: signer.connected,
    snapshot,
    pending: wallet.isPending,
    fetching: wallet.isFetching,
    error: networkError ? new Error(networkError) : wallet.error,
    syncError: networkError ?? wallet.data?.syncError,
  });
  const feeState = deployment.data ? feeFundingState({
    snapshot,
    assetId: deployment.data.policyAsset,
    minimum: 1_500n,
    syncing: wallet.isFetching,
    syncError: networkError ?? syncError,
  }) : "loading";
  const fundingAddress = nextFundingAddress(snapshot);
  const spendableRegulated = snapshot?.utxos.filter((utxo) =>
    utxo.source === "holder" && utxo.assetId === deployment.data?.regulatedAsset && utxo.status === "confirmed"
  ).length ?? 0;

  async function refreshPortfolio() {
    if (!signer.connected) {
      setFeeMessage("Connect the signer to synchronize its wallet.");
      return;
    }
    if (!signerMatchesDeployment) {
      setFeeMessage(networkError);
      return;
    }
    const result = await wallet.refetch();
    if (result.error) setFeeMessage(result.error instanceof Error ? result.error.message : String(result.error));
    else if (result.data?.syncError) setFeeMessage(`Showing the last good wallet state: ${result.data.syncError}`);
    else setFeeMessage(`Wallet synchronized with ${deployment.data ? networkLabel(deployment.data.network) : "the selected network"}.`);
  }

  return (
    <AppShell eyebrow="Holder wallet" title="Your regulated assets">
      {!deployment.data ? (
        <div className="empty-state">
          <span className="empty-icon"><WalletCards size={24} /></span>
          <h2>No deployment selected</h2>
          <p>Import and verify canonical public deployment data without an issuer key.</p>
          <Link className="button primary" to="/wallet/import">Import public deployment</Link>
        </div>
      ) : (
        <>
          <div className="summary-strip">
            <div><span className="overline">Selected deployment</span><strong>{deployment.data.asset.name}</strong><small>{shortHash(deployment.data.deploymentId)} · {deployment.data.confirmations} confirmations</small></div>
            <Pill tone={deployment.data.publication === "published" ? "good" : "warn"}>{publicationLabel(deployment.data.publication)}</Pill>
          </div>
          <div className="wallet-grid">
            <Panel className="balance-card">
              <div className="balance-topline">
                <span className="asset-glyph">{deployment.data.asset.ticker.slice(0, 2)}</span>
                <div><span>{deployment.data.asset.name}</span><small>Simplicity AMP · blacklist only</small></div>
                <Pill tone="blue"><EyeOff size={12} /> Confidential values</Pill>
              </div>
              <div className="balance-value">{presentation.hasSnapshot ? formatUnits(regulated?.confirmed ?? 0n, deployment.data.asset.precision) : "—"}<span>{deployment.data.asset.ticker}</span></div>
              {regulated?.pending ? <p className="pending-balance">+{formatUnits(regulated.pending, deployment.data.asset.precision)} pending confirmation</p> : null}
              <div className="balance-actions"><Link to="/wallet/send" className="button primary"><Send size={16} /> Send</Link><Link to="/wallet/receive" className="button secondary"><Radio size={16} /> Receive</Link></div>
              <div className="card-rule" />
              <div className="stat-row"><span><small>Spendable outputs</small><strong>{presentation.hasSnapshot ? spendableRegulated : "Unknown"}</strong></span><span><small>Supply model</small><strong>{supplyModeLabel(deployment.data.supplyMode)}</strong></span><span><small>Network</small><strong>{networkLabel(deployment.data.network)}</strong></span></div>
            </Panel>
            <Panel className="activity-card">
              <SectionHeading label="Wallet inventory" title="Assets" aside={<Pill tone={presentation.state === "error" || presentation.state === "stale" ? "warn" : presentation.state === "loading" || presentation.state === "syncing" ? "blue" : presentation.state === "synced" ? "good" : "neutral"}>{presentation.state === "stale" ? "Last good state" : presentation.state === "error" ? "Sync error" : presentation.state === "loading" ? "Loading" : presentation.state === "syncing" ? "Syncing" : presentation.state === "synced" ? "Synced" : "Disconnected"}</Pill>} />
              {presentation.state === "disconnected" ? <p>Connect the signer to restore the wallet identified by its collision-resistant public account identity.</p> : presentation.state === "error" ? <div className="wallet-sync-error" role="alert"><p>Wallet balance is unknown because no verified snapshot is available.</p><small>{presentation.message}</small><button className="button secondary" type="button" onClick={() => void wallet.refetch()}>Retry synchronization</button></div> : balances.length === 0 && !snapshot ? <p>Discovering wallet addresses and outputs…</p> : balances.length === 0 ? <p>No wallet assets found.</p> : <div className="asset-list">{balances.map((balance) => <AssetRow key={balance.assetId} balance={balance} deployment={deployment.data!} />)}</div>}
              {snapshot && <small className="sync-time">Last successful sync {new Date(snapshot.syncedAt).toLocaleTimeString()} · through external #{snapshot.scannedThrough.external} and change #{snapshot.scannedThrough.change}</small>}
            </Panel>
          </div>
          <Panel className="fee-panel">
            <div><span className="round-icon"><Fuel size={18} /></span><div><strong>L-BTC transaction fees</strong><p>{feeState === "ready" ? "A confirmed fee output is available." : feeState === "pending" ? "Funding was found and is waiting for confirmation." : feeState === "error" ? "Synchronization failed; faucet actions are paused to avoid duplicate funding." : feeState === "unfunded" ? "No usable L-BTC was found after a successful wallet scan." : signer.connected ? "Scanning derived wallet addresses…" : "Connect the signer to restore and synchronize its wallet."}</p></div></div>
            <div className="fee-actions">
              {feeState === "ready" ? <VerifiedLabel>Fee input ready</VerifiedLabel> : null}
              {feeState === "pending" ? <Pill tone="warn">Confirmation pending</Pill> : null}
              {feeState === "error" ? <Pill tone="warn">Sync error</Pill> : null}
              {feeState === "unfunded" && fundingAddress && deployment.data.network === "liquid-testnet" ? <a className="button secondary" href={liquidTestnetFaucetUrl(fundingAddress.confidentialAddress)} target="_blank" rel="noreferrer" onClick={() => setFeeMessage("Faucet opened for the next unused signer address. Wallet sync will detect the output automatically.")}>Get testnet L-BTC <ExternalLink size={14} /></a> : null}
              <button className="icon-button" disabled={!signer.connected || !signerMatchesDeployment || wallet.isFetching} type="button" aria-label="Refresh wallet funding" onClick={() => void refreshPortfolio()}><RefreshCw size={15} /></button>
            </div>
          </Panel>
          {feeMessage && <p className="inline-message" role="status">{feeMessage}</p>}
          {snapshot && <TechnicalDetails label="Wallet UTXOs"><div className="utxo-list">{snapshot.utxos.filter((utxo) => utxo.status !== "spent" && utxo.status !== "orphaned").map((utxo) => <div key={`${utxo.txid}:${utxo.vout}`}><code>{shortHash(utxo.txid)}:{utxo.vout}</code><span>{utxo.status}</span><span>{shortHash(utxo.assetId)}</span><strong>{utxo.amount}</strong></div>)}{snapshot.utxos.every((utxo) => utxo.status === "spent" || utxo.status === "orphaned") && <p>No current outputs.</p>}</div></TechnicalDetails>}
          <TechnicalDetails label="Deployment details"><dl className="detail-grid"><div><dt>Asset ID</dt><dd>{deployment.data.regulatedAsset}</dd></div><div><dt>Genesis anchor</dt><dd>{deployment.data.genesisAnchor}</dd></div><div><dt>User program</dt><dd>{deployment.data.userProgramHash}</dd></div><div><dt>Governance program</dt><dd>{deployment.data.governanceProgramHash}</dd></div></dl></TechnicalDetails>
        </>
      )}
    </AppShell>
  );
}

export function WalletImport() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [imported, setImported] = useState<Deployment>();
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  async function importPublicDeployment() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await validatePublicDeploymentImport(source);
      const deployment = await persistPublicDeploymentImport(result);
      setImported(deployment);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.activeId }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }),
      ]);
    } catch (failure) {
      setError(userFacingError(failure));
      requestAnimationFrame(() => sourceRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell eyebrow="Holder wallet / Import" title="Import public deployment data">
      <BackLink to="/wallet">Back to wallet</BackLink>
      <div className="flow-layout">
        <Panel className="flow-main">
          <SectionHeading label="Role-neutral import" title="Verify a canonical manifest" />
          {imported ? <div className="operation-receipt" role="status"><Check size={26} /><h3>Deployment ready</h3><p>The canonical manifest, live anchor, and live policy were verified. No issuer-key locator was created.</p><dl><div><dt>Deployment</dt><dd><code>{shortHash(imported.deploymentId, 12, 10)}</code></dd></div><div><dt>Registry state</dt><dd>{publicationLabel(imported.publication)}</dd></div></dl><Link className="button primary wide" to="/wallet">Open holder wallet</Link></div> : <div className="form-stack"><label>Manifest JSON or HTTPS URL<textarea ref={sourceRef} aria-invalid={Boolean(error)} aria-describedby={error ? "holder-import-error" : "holder-import-help"} rows={12} value={source} onChange={(event) => { setSource(event.target.value); setError(undefined); }} />{error ? <small id="holder-import-error" className="field-error">{error}</small> : <small id="holder-import-help">The exact manifest must already exist on the canonical registry default branch.</small>}</label><button className="button primary wide" disabled={busy || !source.trim()} type="button" onClick={() => void importPublicDeployment()}>{busy ? "Verifying public data…" : "Import public deployment"} <Upload size={16} /></button></div>}
        </Panel>
        <aside className="flow-aside"><SafetyNote title="No issuer authority">Holder import stores only public deployment and policy data. Reissuance and governance require a separate local issuer-key attachment in the issuer Setup screen.</SafetyNote></aside>
      </div>
    </AppShell>
  );
}

function AssetRow({ balance, deployment }: { balance: AssetBalance; deployment: Deployment }) {
  const regulated = balance.assetId === deployment.regulatedAsset;
  const policy = balance.assetId === deployment.policyAsset;
  const token = balance.assetId === deployment.reissuanceToken;
  const label = regulated ? deployment.asset.name : policy ? "Liquid Bitcoin" : token ? "Reissuance token" : shortHash(balance.assetId);
  const ticker = regulated ? deployment.asset.ticker : policy ? "L-BTC" : token ? "TOKEN" : "units";
  const precision = regulated ? deployment.asset.precision : policy ? 8 : 0;
  return <div><span><strong>{label}</strong><small>{shortHash(balance.assetId)}</small></span><span><strong>{formatUnits(balance.confirmed, precision)} {ticker}</strong>{balance.pending > 0n ? <small>+{formatUnits(balance.pending, precision)} pending</small> : <small>{balance.confirmedUtxos} confirmed output{balance.confirmedUtxos === 1 ? "" : "s"}</small>}</span></div>;
}

type SendReview = SendForm & { recipientRecord: ReceiveRecord };

async function resolveReceiveRecord(value: string, deployment: Deployment): Promise<ReceiveRecord> {
  const raw = value.trim().startsWith("{")
    ? JSON.parse(value)
    : await fetch(value, { cache: "no-store", headers: { Accept: "application/json" } }).then((response) => {
        if (!response.ok) throw new Error(`Receive-record request failed (${response.status}).`);
        return response.json();
      });
  const record = receiveRecordSchema.parse(raw);
  if (record.deploymentId !== deployment.deploymentId) throw new Error("Receive record belongs to another deployment.");
  await validateReceiveRecordShape(record);
  await validateReceiveRecord(publicManifest(deployment), record);
  return record;
}

export function WalletSend() {
  const deployment = useActiveDeployment();
  const signerState = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const queryClient = useQueryClient();
  const [review, setReview] = useState<SendReview>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const form = useForm<SendForm>({ resolver: zodResolver(sendSchema) });
  const receiptKey = operationReceiptQueryKey(deployment.data?.deploymentId, "transfer", signerState.profileId);
  const receiptQuery = useQuery({
    queryKey: receiptKey,
    enabled: Boolean(deployment.data && signerState.connected && signerState.profileId),
    queryFn: async () => (await loadOperationReceipt(deployment.data!.deploymentId, "transfer", signerState.profileId!)) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const receipt = receiptQuery.data ?? undefined;
  const broadcastInFlight = useRef(false);
  const activeDeploymentId = useRef(deployment.data?.deploymentId);
  activeDeploymentId.current = deployment.data?.deploymentId;

  useEffect(() => {
    setReview(undefined);
    setMessage(undefined);
    form.reset({ recipient: "", amount: "" });
  }, [deployment.data?.deploymentId, form, signerState.profileId]);

  useEffect(() => {
    const key = `transfer:${deployment.data?.deploymentId ?? "none"}:${signerState.profileId ?? "locked"}`;
    setSignerOperationPending(key, Boolean(review || reviewBusy || busy));
    return () => setSignerOperationPending(key, false);
  }, [busy, deployment.data?.deploymentId, review, reviewBusy, signerState.profileId]);

  async function reviewTransfer(values: SendForm) {
    setReviewBusy(true);
    setMessage(undefined);
    const reviewProfileId = signerState.profileId;
    try {
      const selected = requirePublishedDeployment(deployment.data);
      let amount: bigint;
      try {
        amount = parseUnits(values.amount, selected.asset.precision);
        if (amount <= 0n) throw new Error("Transfer amount must be positive.");
      } catch (error) {
        form.setError("amount", { message: userFacingError(error) }, { shouldFocus: true });
        return;
      }
      let recipientRecord: ReceiveRecord;
      try {
        recipientRecord = await resolveReceiveRecord(values.recipient, selected);
      } catch (error) {
        form.setError("recipient", { message: userFacingError(error) }, { shouldFocus: true });
        return;
      }
      if (signerSnapshot().profileId !== reviewProfileId) {
        throw new Error("The active signer profile changed while validating the recipient. Review again.");
      }
      setReview({ ...values, recipientRecord });
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setReviewBusy(false);
    }
  }

  async function send() {
    if (!tryBeginOperation(broadcastInFlight, receipt)) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      if (!review) throw new Error("Review the transfer first.");
      const amount = parseUnits(review.amount, selected.asset.precision);
      if (amount <= 0n) throw new Error("Transfer amount must be positive.");
      // Sign the exact deployment-bound record that was validated and shown on
      // the review screen. A mutable URL must not be able to swap recipients
      // between review and signing.
      const recipient = receiveRecordSchema.parse(review.recipientRecord);
      await validateReceiveRecordShape(recipient);
      await validateReceiveRecord(publicManifest(selected), recipient);
      const esplora = esploraUrlForDeployment(selected);
      const signer = signerSnapshot();
      if (!signer.connected || !signer.profileId) throw new Error("Connect the AMP signer first.");
      const [anchor, wallet] = await Promise.all([
        traverseLiveAnchor(selected, esplora),
        synchronizeDeploymentWallet(selected, signer.profileId),
      ]);
      if (anchor.live.confirmations < 1) throw new Error("The live verifier anchor is not confirmed.");
      const policy = await resolvePolicySnapshot(selected, anchor.live.scriptPubkey);
      const verifierUtxo = await liveAnchorUtxo(selected, anchor.live.txid);
      const regulated = selectSpendableUtxos(wallet, selected.regulatedAsset, "holder");
      const fees = selectSpendableUtxos(wallet, selected.policyAsset, "wallet");
      const fee = BigInt(Math.ceil((650 + Math.min(regulated.length, 10) * 180 + 5 * 100) * 1.25));
      await requireFreshAnchor(selected, anchor.live, esplora);
      const result = await signTransfer({
        deployment: publicManifest(selected),
        currentPolicy: policy,
        verifierUtxo,
        regulatedUtxos: regulated,
        feeUtxos: fees,
        recipient,
        amount: amount.toString(),
        fee: fee.toString(),
      });
      if (signerSnapshot().profileId !== signer.profileId) {
        throw new Error("The active signer profile changed before broadcast. Review the transfer again.");
      }
      if (activeDeploymentId.current !== selected.deploymentId) {
        throw new Error("The active deployment changed before broadcast. Review the transfer again.");
      }
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      const terminalReceipt = createOperationReceipt({
        deployment: selected,
        operation: "transfer",
        txid: result.txid,
        amount: amount.toString(),
        signerProfileId: signer.profileId,
      });
      // Enter the terminal in-memory state before durable persistence. A local
      // storage failure must never re-enable the just-broadcast action.
      queryClient.setQueryData(receiptKey, terminalReceipt);
      let receiptWarning: string | undefined;
      try {
        await saveOperationReceipt(terminalReceipt);
      } catch (error) {
        receiptWarning = ` The receipt could not be saved for reload: ${userFacingError(error)}`;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: walletSyncQueryKeys.wallet(signer.profileId, selected.network) }),
        queryClient.invalidateQueries({ queryKey: ["anchor", selected.deploymentId] }),
        queryClient.invalidateQueries({ queryKey: ["policy", selected.deploymentId] }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }),
      ]);
      setMessage(`Transfer broadcast. Wallet, policy, and anchor synchronization have been requested.${receiptWarning ?? ""}`);
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      finishOperation(broadcastInFlight);
      setBusy(false);
    }
  }

  async function startNewTransfer() {
    const selected = requireDeployment(deployment.data);
    if (!signerState.profileId) throw new Error("Connect the signer profile that created this receipt.");
    await dismissOperationReceipt(selected.deploymentId, "transfer", signerState.profileId);
    queryClient.setQueryData(receiptKey, null);
    setReview(undefined);
    setMessage(undefined);
    form.reset({ recipient: "", amount: "" });
  }

  return (
    <AppShell eyebrow="Holder wallet / Send" title="Build a confidential transfer">
      <BackLink to="/wallet">Back to wallet</BackLink>
      <div className="flow-layout">
        <Panel className="flow-main">
          <SectionHeading label={receipt ? "Receipt" : review ? "Review" : "Recipient and amount"} title={receipt ? "Transfer broadcast" : review ? "Confirm transfer details" : "Who are you paying?"} />
          {!deployment.data ? <p>Import or select a deployment first.</p> : deployment.data.publication !== "published" ? <div className="generate-record"><ShieldCheck size={26} /><p>This deployment is confirmed, but canonical registry publication is still pending. Transfers remain disabled until its manifest and live D4 policy are byte-identical on the registry default branch.</p><Link className="button primary" to="/admin/setup">Finish registry publication</Link></div> : receipt ? <OperationReceiptPanel receipt={receipt} network={deployment.data.network} amountLabel={`${formatUnits(receipt.amount, deployment.data.asset.precision)} ${receipt.ticker}`} resetLabel="Start a new transfer" tone="holder" onReset={() => void startNewTransfer()} /> : !review ? (
            <form onSubmit={form.handleSubmit(reviewTransfer)} className="form-stack">
              <label>Receive record JSON or HTTPS URL<textarea aria-invalid={Boolean(form.formState.errors.recipient)} aria-describedby={form.formState.errors.recipient ? "send-recipient-error" : "send-recipient-help"} rows={5} {...form.register("recipient")} />{form.formState.errors.recipient ? <small id="send-recipient-error" className="field-error">{form.formState.errors.recipient.message}</small> : <small id="send-recipient-help">The record is validated and pinned before review.</small>}</label>
              <label>Amount<div className="amount-input"><input aria-invalid={Boolean(form.formState.errors.amount)} aria-describedby={form.formState.errors.amount ? "send-amount-error" : undefined} inputMode="decimal" {...form.register("amount")} /><span>{deployment.data.asset.ticker}</span></div>{form.formState.errors.amount && <small id="send-amount-error" className="field-error">{form.formState.errors.amount.message}</small>}</label>
              <button className="button primary wide" disabled={reviewBusy} type="submit">{reviewBusy ? "Validating recipient…" : "Review transfer"} <ArrowRight size={16} /></button>
            </form>
          ) : (
            <div className="review-stack">
              <ReviewRow label="Recipient" value={`${review.recipientRecord.alias} · ${shortHash(review.recipientRecord.confidentialAddress, 12, 8)}`} />
              <ReviewRow label="Amount" value={`${review.amount} ${deployment.data.asset.ticker}`} />
              <ReviewRow label="Asset ID" value={shortHash(deployment.data.regulatedAsset, 12, 10)} />
              <ReviewRow label="Policy" value="Canonical live blacklist" good />
              <div className="review-buttons"><button className="button secondary" disabled={busy} type="button" onClick={() => setReview(undefined)}>Edit</button><button className="button primary" disabled={busy || receiptQuery.isPending || !signerState.walletReady} type="button" onClick={send}>{busy ? "Building…" : !signerState.walletReady ? "Sync wallet before signing" : "Sign locally"} <ArrowRight size={16} /></button></div>
            </div>
          )}
          {message && <p className="inline-message" role="status">{message}</p>}
        </Panel>
        <aside className="flow-aside"><SafetyNote title="Fail closed before signing">The app validates the receive record, resolves policy from the live anchor, proves every selected outpoint, and rechecks chain state.</SafetyNote><Panel><h3>Transaction rules</h3><ul className="check-list"><li><Check size={15} /> Verifier at input/output 0</li><li><Check size={15} /> Holder at input 1</li><li><Check size={15} /> At most ten regulated inputs/outputs</li><li><Check size={15} /> Explicit assets, value-only blinding</li></ul></Panel></aside>
      </div>
    </AppShell>
  );
}

function ReviewRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="review-row"><span>{label}</span><strong>{value} {good && <Check size={14} />}</strong></div>;
}

export function WalletReceive() {
  const deployment = useActiveDeployment();
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string>();
  const [copying, setCopying] = useState(false);
  const storedRecords = useQuery({
    queryKey: ["receive-record", deployment.data?.deploymentId, signer.profileId],
    enabled: Boolean(deployment.data && signer.connected && signer.profileId),
    queryFn: () => ensureSignerReceiveRecord(requireDeployment(deployment.data), signer.profileId!),
  });
  const record = storedRecords.data?.record;
  const encoded = useMemo(() => record ? JSON.stringify(record) : "", [record]);

  useEffect(() => {
    setCopied(false);
  }, [encoded]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => {
      setCopied(false);
      setMessage(undefined);
    }, 2_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function generate() {
    try {
      const selected = requireDeployment(deployment.data);
      if (!signer.connected || !signer.profileId) throw new Error("Connect the AMP signer first.");
      const created = await ensureSignerReceiveRecord(selected, signer.profileId);
      queryClient.setQueryData(["receive-record", selected.deploymentId, signer.profileId], created);
    } catch (error) {
      setMessage(userFacingError(error));
    }
  }

  async function copyRecord() {
    setCopying(true);
    setMessage("Copying the public receive record…");
    try {
      await navigator.clipboard.writeText(encoded);
      setCopied(true);
      setMessage("Public receive record copied. Share it with the sender for this deployment only.");
    } catch (error) {
      setCopied(false);
      setMessage(`Could not copy the receive record: ${userFacingError(error)}`);
    } finally {
      setCopying(false);
    }
  }

  return (
    <AppShell eyebrow="Holder wallet / Receive" title="Receive regulated assets">
      <BackLink to="/wallet">Back to wallet</BackLink>
      <div className="receive-layout">
        <Panel className="receive-card"><SectionHeading label="Deployment-bound receive record" title="Share this with the sender" />{!deployment.data ? <div className="generate-record"><Radio size={26} /><p>No deployment is selected. Import or create one before generating a deployment-bound receive record.</p><Link className="button primary" to="/admin/setup">Open Setup</Link></div> : record ? <><div className="qr-wrap"><QRCodeSVG value={encoded} size={188} level="M" /></div><p className="receive-address">{record.confidentialAddress}</p><button className="button primary wide" disabled={copying} type="button" onClick={() => void copyRecord()}>{copied ? <Check size={16} /> : <Copy size={16} />} {copying ? "Copying…" : copied ? "Copied" : "Copy receive record"}</button></> : <div className="generate-record"><Radio size={26} /><p>The AMP Signer SDK derives owner and blinding keys, constructs the exact user covenant, and signs the deployment-bound BIP322 record locally.</p><button className="button primary" disabled={!signer.connected || storedRecords.isFetching} type="button" onClick={generate}>{storedRecords.isFetching ? "Restoring…" : "Generate locally"}</button></div>}{storedRecords.error instanceof Error && <p className="field-error">{storedRecords.error.message}</p>}{message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}</Panel>
        <div className="receive-notes"><SafetyNote title="Safe to publish">Only public keys, the covenant script, confidential address, and ownership proof are exported.</SafetyNote><Panel><h3>Sender verification</h3><ul className="check-list"><li><ShieldCheck size={15} /> Deployment binding</li><li><ShieldCheck size={15} /> Exact holder script</li><li><ShieldCheck size={15} /> BIP322 ownership proof</li><li><ShieldCheck size={15} /> Address and blinding key</li></ul></Panel><div className="info-line"><Info size={15} /> Direct JSON works without a registry account.</div></div>
      </div>
    </AppShell>
  );
}
