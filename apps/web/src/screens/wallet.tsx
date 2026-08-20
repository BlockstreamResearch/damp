import { useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { QRCodeSVG } from "qrcode.react";
import { z } from "zod";
import { ArrowRight, Check, Copy, ExternalLink, EyeOff, Fuel, Info, Radio, RefreshCw, Send, ShieldCheck, WalletCards } from "lucide-react";

import {
  AppShell,
  BackLink,
  Panel,
  Pill,
  SafetyNote,
  SectionHeading,
  TechnicalDetails,
  VerifiedLabel,
  WalletStatus,
} from "../components/ui";
import {
  createReceiveRecord,
  deriveWalletAddress,
  signTransfer,
  signerSnapshot,
  subscribeSigner,
  validateReceiveRecord,
  validateReceiveRecordShape,
} from "../lib/amp-signer";
import {
  broadcastTransaction,
  inspectAndFilter,
  liveAnchorUtxo,
  scanHolderUtxos,
  scanWalletUtxos,
} from "../lib/chain-wallet";
import { useActiveDeployment } from "../lib/deployments";
import {
  formatUnits,
  parseUnits,
  publicManifest,
  receiveRecordSchema,
  requireDeployment,
  requirePublishedDeployment,
  shortHash,
  type Deployment,
  type ReceiveRecord,
} from "../lib/domain";
import { esploraUrlForDeployment, requireFreshAnchor, traverseLiveAnchor } from "../lib/esplora";
import { liquidTestnetFaucetUrl } from "../lib/faucet";
import { resolvePolicySnapshot } from "../lib/policy-registry";
import { listReceiveRecords, putReceiveRecord } from "../lib/store";

function usePortfolio(deployment: Deployment | null | undefined, signerConnected: boolean) {
  return useQuery({
    queryKey: ["portfolio", deployment?.deploymentId, signerConnected],
    enabled: Boolean(deployment && signerConnected),
    queryFn: async () => {
      const selected = requireDeployment(deployment);
      const records = await listReceiveRecords(selected.deploymentId);
      const [holderUtxos, walletUtxos] = await Promise.all([
        scanHolderUtxos(selected, records),
        scanWalletUtxos(selected),
      ]);
      const [regulated, fees] = await Promise.all([
        inspectAndFilter(holderUtxos, selected.regulatedAsset),
        inspectAndFilter(walletUtxos, selected.policyAsset),
      ]);
      return {
        balance: regulated.inspected.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n),
        utxos: regulated.utxos.length,
        feeReady: fees.inspected.length > 0,
      };
    },
  });
}

export function WalletDashboard() {
  const deployment = useActiveDeployment();
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const portfolio = usePortfolio(deployment.data, signer.connected);
  const queryClient = useQueryClient();
  const [feeMessage, setFeeMessage] = useState<string>();
  const fundingAddress = useQuery({
    queryKey: ["fee-funding-address", signer.fingerprint, deployment.data?.network],
    enabled: Boolean(signer.connected && deployment.data?.network === "liquid-testnet"),
    queryFn: () => deriveWalletAddress(0, 0, requireDeployment(deployment.data).network),
  });

  async function refreshPortfolio() {
    await queryClient.invalidateQueries({ queryKey: ["portfolio", deployment.data?.deploymentId] });
    setFeeMessage("Wallet funding scan refreshed. Faucet outputs become spendable after confirmation.");
  }

  return (
    <AppShell role="holder" eyebrow="Holder wallet" title="Your regulated assets">
      {!deployment.data ? (
        <div className="empty-state">
          <span className="empty-icon"><WalletCards size={24} /></span>
          <h2>No deployment selected</h2>
          <p>Import a strict public manifest in Setup, then select it from the sidebar.</p>
          <Link className="button primary" to="/admin/setup">Import deployment</Link>
        </div>
      ) : (
        <>
          <div className="summary-strip">
            <div><span className="overline">Selected deployment</span><strong>{deployment.data.asset.name}</strong><small>{shortHash(deployment.data.deploymentId)} · {deployment.data.confirmations} confirmations</small></div>
            <Pill tone={deployment.data.publication === "published" ? "good" : "warn"}>{deployment.data.publication}</Pill>
          </div>
          <div className="wallet-grid">
            <Panel className="balance-card">
              <div className="balance-topline">
                <span className="asset-glyph">{deployment.data.asset.ticker.slice(0, 2)}</span>
                <div><span>{deployment.data.asset.name}</span><small>Simplicity AMP · blacklist only</small></div>
                <Pill tone="blue"><EyeOff size={12} /> Confidential values</Pill>
              </div>
              <div className="balance-value">{portfolio.isPending ? "—" : formatUnits(portfolio.data?.balance ?? 0n, deployment.data.asset.precision)}<span>{deployment.data.asset.ticker}</span></div>
              <div className="balance-actions"><Link to="/wallet/send" className="button primary"><Send size={16} /> Send</Link><Link to="/wallet/receive" className="button secondary"><Radio size={16} /> Receive</Link></div>
              <div className="card-rule" />
              <div className="stat-row"><span><small>Spendable outputs</small><strong>{portfolio.data?.utxos ?? 0}</strong></span><span><small>Supply model</small><strong>{deployment.data.supplyMode}</strong></span><span><small>Network</small><strong>{deployment.data.network}</strong></span></div>
            </Panel>
            <Panel className="activity-card"><SectionHeading label="Deployment state" title="Live data only" /><p>Balances and actions are scoped by deployment ID. The signer SDK validates every selected chain output locally.</p></Panel>
          </div>
          <Panel className="fee-panel">
            <div><span className="round-icon"><Fuel size={18} /></span><div><strong>L-BTC transaction fees</strong><p>Fund the local signer on Liquid testnet, then refresh after confirmation.</p></div></div>
            {portfolio.data?.feeReady ? (
              <VerifiedLabel>Fee input ready</VerifiedLabel>
            ) : fundingAddress.data ? (
              <div className="fee-actions">
                <a className="button secondary" href={liquidTestnetFaucetUrl(fundingAddress.data.confidentialAddress)} target="_blank" rel="noreferrer" onClick={() => setFeeMessage("Faucet opened for the signer funding address. Wait for confirmation, then refresh.")}>
                  Get testnet L-BTC <ExternalLink size={14} />
                </a>
                <button className="icon-button" type="button" aria-label="Refresh fee funding" onClick={() => void refreshPortfolio()}><RefreshCw size={15} /></button>
              </div>
            ) : (
              <button className="button secondary" type="button" onClick={() => setFeeMessage("Connect the signer to derive its Liquid testnet funding address.")}>Connect to fund</button>
            )}
          </Panel>
          {feeMessage && <p className="inline-message" role="status">{feeMessage}</p>}
          <TechnicalDetails label="Deployment details"><dl className="detail-grid"><div><dt>Asset ID</dt><dd>{deployment.data.regulatedAsset}</dd></div><div><dt>Genesis anchor</dt><dd>{deployment.data.genesisAnchor}</dd></div><div><dt>User program</dt><dd>{deployment.data.userProgramHash}</dd></div><div><dt>Governance program</dt><dd>{deployment.data.governanceProgramHash}</dd></div></dl></TechnicalDetails>
        </>
      )}
    </AppShell>
  );
}

const sendSchema = z.object({
  recipient: z.string().trim().min(1, "Paste a receive-record JSON or URL"),
  amount: z.string().trim().min(1),
});
type SendForm = z.infer<typeof sendSchema>;

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
  const [review, setReview] = useState<SendForm>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = useForm<SendForm>({ resolver: zodResolver(sendSchema) });

  async function send() {
    setBusy(true);
    setMessage(undefined);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      if (!review) throw new Error("Review the transfer first.");
      const amount = parseUnits(review.amount, selected.asset.precision);
      if (amount <= 0n) throw new Error("Transfer amount must be positive.");
      const recipient = await resolveReceiveRecord(review.recipient, selected);
      const esplora = esploraUrlForDeployment(selected);
      const anchor = await traverseLiveAnchor(selected, esplora);
      if (anchor.live.confirmations < 1) throw new Error("The live verifier anchor is not confirmed.");
      const policy = await resolvePolicySnapshot(selected, anchor.live.scriptPubkey);
      const records = await listReceiveRecords(selected.deploymentId);
      const [holderUtxos, walletUtxos, verifierUtxo] = await Promise.all([
        scanHolderUtxos(selected, records),
        scanWalletUtxos(selected),
        liveAnchorUtxo(selected, anchor.live.txid),
      ]);
      const [regulated, fees] = await Promise.all([
        inspectAndFilter(holderUtxos, selected.regulatedAsset),
        inspectAndFilter(walletUtxos, selected.policyAsset),
      ]);
      const fee = BigInt(Math.ceil((650 + Math.min(regulated.utxos.length, 10) * 180 + 5 * 100) * 1.25));
      await requireFreshAnchor(selected, anchor.live, esplora);
      const result = await signTransfer({
        deployment: publicManifest(selected),
        currentPolicy: policy,
        verifierUtxo,
        regulatedUtxos: regulated.utxos,
        feeUtxos: fees.utxos,
        recipient,
        amount: amount.toString(),
        fee: fee.toString(),
      });
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      setMessage(`Transfer broadcast: ${result.txid}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell role="holder" eyebrow="Holder wallet / Send" title="Build a confidential transfer" action={<WalletStatus />}>
      <BackLink to="/wallet">Back to wallet</BackLink>
      <div className="flow-layout">
        <Panel className="flow-main">
          <SectionHeading label={review ? "Review" : "Recipient and amount"} title={review ? "Confirm transfer details" : "Who are you paying?"} />
          {!deployment.data ? <p>Import or select a deployment first.</p> : !review ? (
            <form onSubmit={form.handleSubmit(setReview)} className="form-stack">
              <label>Receive record JSON or HTTPS URL<textarea rows={5} {...form.register("recipient")} />{form.formState.errors.recipient && <small className="field-error">{form.formState.errors.recipient.message}</small>}</label>
              <label>Amount<div className="amount-input"><input inputMode="decimal" {...form.register("amount")} /><span>{deployment.data.asset.ticker}</span></div></label>
              <button className="button primary wide" type="submit">Review transfer <ArrowRight size={16} /></button>
            </form>
          ) : (
            <div className="review-stack">
              <ReviewRow label="Recipient" value={review.recipient.startsWith("{") ? "Direct receive record" : review.recipient} />
              <ReviewRow label="Amount" value={`${review.amount} ${deployment.data.asset.ticker}`} />
              <ReviewRow label="Asset ID" value={shortHash(deployment.data.regulatedAsset, 12, 10)} />
              <ReviewRow label="Policy" value="Canonical live blacklist" good />
              <div className="review-buttons"><button className="button secondary" type="button" onClick={() => setReview(undefined)}>Edit</button><button className="button primary" disabled={busy} type="button" onClick={send}>{busy ? "Building…" : "Sign locally"} <ArrowRight size={16} /></button></div>
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
  const [copied, setCopied] = useState(false);
  const [record, setRecord] = useState<ReceiveRecord>();
  const [message, setMessage] = useState<string>();
  const encoded = useMemo(() => record ? JSON.stringify(record) : "", [record]);

  async function generate() {
    try {
      const selected = requireDeployment(deployment.data);
      const created = await createReceiveRecord(publicManifest(selected), selected.deploymentId, selected.asset.ticker.toLowerCase());
      const parsed = receiveRecordSchema.parse(created.record);
      await validateReceiveRecordShape(parsed);
      await validateReceiveRecord(publicManifest(selected), parsed);
      await putReceiveRecord(parsed, created.derivationIndex);
      setRecord(parsed);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <AppShell role="holder" eyebrow="Holder wallet / Receive" title="Receive regulated assets">
      <BackLink to="/wallet">Back to wallet</BackLink>
      <div className="receive-layout">
        <Panel className="receive-card"><SectionHeading label="Deployment-bound receive record" title="Share this with the sender" />{record ? <><div className="qr-wrap"><QRCodeSVG value={encoded} size={188} level="M" /></div><p className="receive-address">{record.confidentialAddress}</p><button className="button primary wide" type="button" onClick={() => navigator.clipboard.writeText(encoded).then(() => setCopied(true))}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy receive record"}</button></> : <div className="generate-record"><Radio size={26} /><p>The AMP Signer SDK derives owner and blinding keys, constructs the exact user covenant, and signs the deployment-bound BIP322 record locally.</p><button className="button primary" type="button" onClick={generate}>Generate locally</button></div>}{message && <p className="inline-message" role="status">{message}</p>}</Panel>
        <div className="receive-notes"><SafetyNote title="Safe to publish">Only public keys, the covenant script, confidential address, and ownership proof are exported.</SafetyNote><Panel><h3>Sender verification</h3><ul className="check-list"><li><ShieldCheck size={15} /> Deployment binding</li><li><ShieldCheck size={15} /> Exact holder script</li><li><ShieldCheck size={15} /> BIP322 ownership proof</li><li><ShieldCheck size={15} /> Address and blinding key</li></ul></Panel><div className="info-line"><Info size={15} /> Direct JSON works without a registry account.</div></div>
      </div>
    </AppShell>
  );
}
