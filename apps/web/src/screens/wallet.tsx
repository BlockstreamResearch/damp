import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { QRCodeSVG } from "qrcode.react";
import { AlertTriangle, ArrowRight, Check, ExternalLink, EyeOff, Fuel, Info, Radio, RefreshCw, Send, ShieldCheck, Upload, WalletCards } from "lucide-react";

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
import { CopyableAddress } from "../components/copyable-address";
import {
  signTransfer,
  signerSnapshot,
  subscribeSigner,
} from "../lib/amp-signer";
import {
  broadcastTransaction,
  liveAnchorUtxo,
} from "../lib/chain-wallet";
import { deploymentQueryKeys, useActiveDeployment, useOfficialDeployments } from "../lib/deployments";
import {
  formatUnits,
  networkLabel,
  publicationLabel,
  publicManifest,
  requireDeployment,
  requirePublishedDeployment,
  shortHash,
  supplyModeLabel,
  userFacingError,
  type Deployment,
  type PolicySnapshot,
} from "../lib/domain";
import {
  persistPublicDeploymentImport,
  validatePublicDeploymentImport,
} from "../lib/deployment-import";
import { esploraUrlForDeployment, requireFreshAnchor, traverseLiveAnchor } from "../lib/esplora";
import { liquidTestnetFaucetUrl } from "../lib/faucet";
import { canonicalRegistryContent, customGitHubManifestSource, registryRepositoryUrl, type CanonicalDeployment } from "../lib/github";
import { resolvePolicySnapshot } from "../lib/policy-registry";
import { classifyRegulatedFunds, type RegulatedFunds } from "../lib/regulated-funds";
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
import { hasPendingSignerOperation, setSignerOperationPending } from "../lib/signer-operation-state";
import {
  assetBalances,
  ensureSignerHolderAddress,
  feeFundingState,
  nextFundingAddress,
  synchronizeDeploymentWallet,
  type AssetBalance,
  type WalletSyncSnapshot,
} from "../lib/wallet-sync";
import {
  TransferValidationError,
  parseTransferAmount,
  resolveAndValidateRecipientAddress,
  selectTransferFunding,
  type TransferFundingSelection,
} from "../lib/transfer-validation";

export function WalletDashboard() {
  const deployment = useActiveDeployment();
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const signerMatchesDeployment = !deployment.data || signer.network === deployment.data.network;
  const wallet = useDeploymentWalletSync(
    deployment.data,
    signer.connected && signerMatchesDeployment ? signer.profileId : undefined,
  );
  const policyVerification = useQuery({
    queryKey: ["holder-live-policy", deployment.data?.deploymentId],
    enabled: deployment.data?.publication === "published",
    staleTime: 10_000,
    queryFn: async () => {
      const selected = requirePublishedDeployment(deployment.data);
      const anchor = await traverseLiveAnchor(selected, esploraUrlForDeployment(selected));
      if (anchor.live.confirmations < 1) throw new Error("The live verifier anchor is not confirmed.");
      const policy = await resolvePolicySnapshot(selected, anchor.live.scriptPubkey);
      return { anchor: anchor.live, policy };
    },
  });
  const [feeMessage, setFeeMessage] = useState<string>();
  const snapshot = wallet.data?.snapshot;
  const balances = useMemo(() => assetBalances(snapshot), [snapshot]);
  const regulated = balances.find((balance) => balance.assetId === deployment.data?.regulatedAsset);
  const regulatedFunds = useMemo(() => deployment.data && snapshot && policyVerification.data
    ? classifyRegulatedFunds(snapshot, deployment.data, policyVerification.data.policy)
    : undefined, [deployment.data, policyVerification.data, snapshot]);
  const blacklistedOutpoints = useMemo(() => new Set(policyVerification.data?.policy.entries.map((entry) => `${entry.txid}:${entry.vout}`) ?? []), [policyVerification.data?.policy.entries]);
  const syncError = wallet.data?.syncError ?? (wallet.error instanceof Error ? wallet.error.message : undefined);
  const networkError = deployment.data && signer.connected && signer.network !== deployment.data.network
    ? `Reconnect the DAMP signer for ${networkLabel(deployment.data.network)}.`
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
  const canRequestTestFunds = presentation.state === "synced"
    && deployment.data?.network === "liquid-testnet"
    && Boolean(fundingAddress);
  const policyChecking = deployment.data?.publication === "published" && policyVerification.isPending && !policyVerification.data;

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
        <HolderOnboarding />
      ) : (
        <>
          {!signer.connected && <div className="first-run-callout" role="status"><div><strong>Connect a test signer to use this deployment</strong><p>The selected network is prefilled. Create or restore a disposable debug profile to synchronize balances and enable receiving and sending.</p></div><button className="button primary" type="button" onClick={() => document.getElementById("damp-signer-trigger")?.click()}>Connect test signer</button></div>}
          <div className="summary-strip">
            <div><span className="overline">Selected deployment</span><strong>{deployment.data.asset.name}</strong><small>{shortHash(deployment.data.deploymentId)} · {deployment.data.confirmations} confirmations</small></div>
            <Pill tone={deployment.data.publication === "published" ? "good" : "warn"}>{publicationLabel(deployment.data.publication)}</Pill>
          </div>
          <div className="wallet-grid">
            <Panel className="balance-card">
              <div className="balance-topline">
                <span className="asset-glyph">{deployment.data.asset.ticker.slice(0, 2)}</span>
                <div><span>{deployment.data.asset.name}</span><small>Verified spendable balance · blacklist only</small></div>
                <Pill tone="blue"><EyeOff size={12} /> Confidential addresses</Pill>
              </div>
              <div className="balance-value">{presentation.hasSnapshot && regulatedFunds ? formatUnits(regulatedFunds.spendable, deployment.data.asset.precision) : "—"}<span>{deployment.data.asset.ticker}</span></div>
              {regulated?.pending ? <p className="pending-balance">+{formatUnits(regulated.pending, deployment.data.asset.precision)} pending confirmation</p> : null}
              {deployment.data.publication !== "published" ? <p className="policy-balance-state" role="status">Balance verification starts after registry publication.</p> : policyChecking ? <p className="policy-balance-state" role="status">Checking the live blacklist before marking funds spendable…</p> : policyVerification.error && !policyVerification.data ? <div className="policy-balance-error" role="alert"><strong>Spendable balance unavailable</strong><span>{userFacingError(policyVerification.error)}</span><button className="button secondary" type="button" onClick={() => void policyVerification.refetch()}>Recheck policy</button></div> : regulatedFunds && regulatedFunds.blacklisted > 0n ? <div className="blacklisted-balance" role="status"><AlertTriangle size={16} /><span><strong>Blacklisted — cannot be spent</strong>{formatUnits(regulatedFunds.blacklisted, deployment.data.asset.precision)} {deployment.data.asset.ticker} in {regulatedFunds.blacklistedUtxos.length} output{regulatedFunds.blacklistedUtxos.length === 1 ? "" : "s"}</span></div> : null}
              <div className="balance-actions"><Link to="/wallet/send" className="button primary"><Send size={16} /> Send</Link><Link to="/wallet/receive" className="button secondary"><Radio size={16} /> Receive</Link></div>
              <div className="card-rule" />
              <div className="stat-row"><span><small>Spendable outputs</small><strong>{regulatedFunds ? regulatedFunds.spendableUtxos.length : "Unknown"}</strong></span><span><small>Supply model</small><strong>{supplyModeLabel(deployment.data.supplyMode)}</strong></span><span><small>Network</small><strong>{networkLabel(deployment.data.network)}</strong></span></div>
            </Panel>
            <Panel className="activity-card">
              <SectionHeading label="Wallet inventory" title="Assets" aside={<Pill tone={presentation.state === "error" || presentation.state === "stale" ? "warn" : presentation.state === "loading" || presentation.state === "syncing" ? "blue" : presentation.state === "synced" ? "good" : "neutral"}>{presentation.state === "stale" ? "Last good state" : presentation.state === "error" ? "Sync error" : presentation.state === "loading" ? "Loading" : presentation.state === "syncing" ? "Syncing" : presentation.state === "synced" ? "Synced" : "Disconnected"}</Pill>} />
              {presentation.state === "disconnected" ? <p>Connect the signer to restore the wallet identified by its collision-resistant public account identity.</p> : presentation.state === "error" ? <div className="wallet-sync-error" role="alert"><p>Wallet balance is unknown because no verified snapshot is available.</p><small>{presentation.message}</small><button className="button secondary" type="button" onClick={() => void wallet.refetch()}>Retry synchronization</button></div> : balances.length === 0 && !snapshot ? <p>Discovering wallet addresses and outputs…</p> : balances.length === 0 ? <p>No wallet assets found.</p> : <div className="asset-list">{balances.map((balance) => <AssetRow key={balance.assetId} balance={balance} deployment={deployment.data!} regulatedFunds={balance.assetId === deployment.data!.regulatedAsset ? regulatedFunds : undefined} />)}</div>}
              {snapshot && <small className="sync-time">Last successful sync {new Date(snapshot.syncedAt).toLocaleTimeString()} · through external #{snapshot.scannedThrough.external} and change #{snapshot.scannedThrough.change}</small>}
            </Panel>
          </div>
          <Panel className="fee-panel">
            <div><span className="round-icon"><Fuel size={18} /></span><div><strong>L-BTC transaction fees</strong><p>{feeState === "ready" ? "A confirmed fee output is available. You can still request additional test funds." : feeState === "pending" ? "Funding is waiting for confirmation. Additional test requests remain available." : feeState === "error" ? "Synchronization failed; refresh before requesting more test funds." : feeState === "unfunded" ? "No usable L-BTC was found after a successful wallet scan." : signer.connected ? "Scanning derived wallet addresses…" : "Connect the signer to restore and synchronize its wallet."}</p></div></div>
            <div className="fee-actions">
              {feeState === "ready" ? <VerifiedLabel>Fee input ready</VerifiedLabel> : null}
              {feeState === "pending" ? <Pill tone="warn">Confirmation pending</Pill> : null}
              {feeState === "error" ? <Pill tone="warn">Sync error</Pill> : null}
              {canRequestTestFunds && fundingAddress && signer.profileId ? <><CopyableAddress address={fundingAddress.confidentialAddress} resetKey={`${signer.profileId}:liquid-testnet:0:${fundingAddress.index}`} accessibleLabel={`Copy external receive address ${fundingAddress.index}`} display={`External #${fundingAddress.index} · ${shortHash(fundingAddress.confidentialAddress, 10, 7)}`} className="fee-funding-address" onNotice={(notice) => setFeeMessage(notice.message)} /><a className="button secondary" href={liquidTestnetFaucetUrl(fundingAddress.confidentialAddress)} target="_blank" rel="noreferrer" onClick={() => setFeeMessage("The external Liquid testnet faucet opened and received this public test address. Synchronize the wallet after funding.")}>Open testnet faucet <ExternalLink size={14} /></a></> : null}
              <button className="icon-button" disabled={!signer.connected || !signerMatchesDeployment || wallet.isFetching} type="button" aria-label="Synchronize wallet" title="Synchronize wallet" onClick={() => void refreshPortfolio()}><RefreshCw size={15} /></button>
            </div>
          </Panel>
          {feeMessage && <p className="inline-message" role="status">{feeMessage}</p>}
          {snapshot && <TechnicalDetails label="Wallet UTXOs"><div className="table-wrap"><table className="utxo-table"><caption>Current unspent and pending wallet outputs</caption><thead><tr><th scope="col">Outpoint</th><th scope="col">State</th><th scope="col">Asset</th><th scope="col">Amount</th></tr></thead><tbody>{snapshot.utxos.filter((utxo) => utxo.status !== "spent" && utxo.status !== "orphaned").map((utxo) => { const blacklisted = blacklistedOutpoints.has(`${utxo.txid}:${utxo.vout}`); const asset = walletUtxoAsset(utxo.assetId, deployment.data!); return <tr key={`${utxo.txid}:${utxo.vout}`}><td data-label="Outpoint"><code title={`${utxo.txid}:${utxo.vout}`}>{shortHash(utxo.txid)}:{utxo.vout}</code></td><td data-label="State">{blacklisted ? <Pill tone="danger">Blacklisted — cannot be spent</Pill> : <Pill tone={utxo.status === "confirmed" ? "good" : "warn"}>{utxo.status}</Pill>}</td><td data-label="Asset"><strong>{asset.label}</strong><code title={utxo.assetId}>{shortHash(utxo.assetId)}</code></td><td data-label="Amount">{formatUnits(utxo.amount, asset.precision)} {asset.ticker}</td></tr>; })}{snapshot.utxos.every((utxo) => utxo.status === "spent" || utxo.status === "orphaned") && <tr><td className="table-empty" colSpan={4}>No current outputs.</td></tr>}</tbody></table></div></TechnicalDetails>}
          <TechnicalDetails label="Deployment details"><dl className="detail-grid"><div><dt>Asset ID</dt><dd>{deployment.data.regulatedAsset}</dd></div><div><dt>Genesis anchor</dt><dd>{deployment.data.genesisAnchor}</dd></div><div><dt>User program</dt><dd>{deployment.data.userProgramHash}</dd></div><div><dt>Governance program</dt><dd>{deployment.data.governanceProgramHash}</dd></div></dl></TechnicalDetails>
        </>
      )}
    </AppShell>
  );
}

export function WalletImport() {
  return (
    <AppShell eyebrow="Holder wallet / Import" title="Import public deployment data">
      <BackLink to="/wallet">Back to wallet</BackLink>
      <HolderOnboarding />
    </AppShell>
  );
}

function HolderOnboarding() {
  const queryClient = useQueryClient();
  const official = useOfficialDeployments();
  const [source, setSource] = useState("");
  const [sourceKind, setSourceKind] = useState<"custom" | "manual">("custom");
  const [busy, setBusy] = useState(false);
  const [busyOfficialId, setBusyOfficialId] = useState<string>();
  const [officialImportError, setOfficialImportError] = useState<string>();
  const [error, setError] = useState<string>();
  const [imported, setImported] = useState<Deployment>();
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const customSourceRef = useRef<HTMLInputElement>(null);

  async function finishImport(value: string, registryRepository?: string) {
    const result = await validatePublicDeploymentImport(value, {}, registryRepository);
    const deployment = await persistPublicDeploymentImport(result);
    setImported(deployment);
    await queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all });
  }

  async function importOfficialDeployment(entry: CanonicalDeployment) {
    setBusyOfficialId(entry.deploymentId);
    setOfficialImportError(undefined);
    try {
      await finishImport(canonicalRegistryContent(entry.manifest));
    } catch (failure) {
      setOfficialImportError(userFacingError(failure));
    } finally {
      setBusyOfficialId(undefined);
    }
  }

  async function importPublicDeployment() {
    setBusy(true);
    setError(undefined);
    try {
      const custom = sourceKind === "custom" ? await customGitHubManifestSource(source) : undefined;
      await finishImport(custom?.manifestUrl ?? source, custom?.sourceRepository);
    } catch (failure) {
      setError(userFacingError(failure));
      requestAnimationFrame(() => {
        if (sourceKind === "custom") customSourceRef.current?.focus();
        else sourceRef.current?.focus();
      });
    } finally {
      setBusy(false);
    }
  }

  return (
      <div className="flow-layout holder-onboarding">
        <Panel className="flow-main">
          <SectionHeading label="Choose a trusted source" title="Add a public deployment" />
          {imported ? <div className="operation-receipt" role="status"><Check size={26} /><h3>Deployment ready</h3><p>The source manifest, live anchor, and live policy were verified. No issuer-key locator was created.</p><dl><div><dt>Deployment</dt><dd><code>{shortHash(imported.deploymentId, 12, 10)}</code></dd></div><div><dt>Registry state</dt><dd>{publicationLabel(imported.publication)}</dd></div></dl><Link className="button primary wide" to="/wallet">Open holder wallet</Link></div> : <>
            <div className="onboarding-source-grid">
              <section className="official-registry-source"><ShieldCheck size={20} /><div><strong>Official public registry</strong><p>Discover and verify deployments published in the official GitHub repository.</p><small role={official.error ? "alert" : "status"}>{official.isPending ? "Synchronizing official GitHub deployments…" : official.error ? `Official sync failed: ${userFacingError(official.error)}` : `${official.data?.length ?? 0} deployment${official.data?.length === 1 ? "" : "s"} available`}</small></div><a className="button secondary" href={registryRepositoryUrl} target="_blank" rel="noreferrer">View source <ExternalLink size={14} /></a>{official.data?.length ? <div className="official-deployment-list" aria-label="Official deployments">{official.data.map((entry) => <button className="official-deployment-choice" disabled={Boolean(busyOfficialId) || busy} key={entry.deploymentId} type="button" onClick={() => void importOfficialDeployment(entry)}><span><strong>{entry.manifest.asset.name}</strong><small>{entry.manifest.asset.ticker} · {shortHash(entry.deploymentId, 10, 8)}</small></span><span>{busyOfficialId === entry.deploymentId ? "Verifying…" : "Import"}</span></button>)}</div> : null}{officialImportError ? <small className="field-error" role="alert">Official import failed: {officialImportError}</small> : null}</section>
              <section><Upload size={20} /><div><strong>Custom GitHub registry</strong><p>Trusts the repository you specify. The manifest must be on its default branch; DAMP pins that repository for later policy resolution.</p></div><button className={`button ${sourceKind === "custom" ? "primary" : "secondary"}`} type="button" onClick={() => { setSourceKind("custom"); setSource(""); setError(undefined); }}>Use custom GitHub</button></section>
              <section><Info size={20} /><div><strong>Advanced manual import</strong><p>Paste canonical manifest JSON or a direct HTTPS URL, then verify it against the official registry.</p></div><button className="button secondary" type="button" onClick={() => { setSourceKind("manual"); setSource(""); setError(undefined); requestAnimationFrame(() => sourceRef.current?.focus()); }}>Open manual import</button></section>
              <section><WalletCards size={20} /><div><strong>Create your own asset</strong><p>Switch to Issuer Console Setup to create a new regulated asset and deployment.</p></div><Link className="button secondary" to="/admin/setup">Open Issuer Setup</Link></section>
            </div>
            {sourceKind === "custom" ? <div className="form-stack source-entry"><label>Custom GitHub manifest URL<input ref={customSourceRef} aria-invalid={Boolean(error)} aria-describedby={error ? "holder-import-error" : "holder-import-help"} placeholder="https://github.com/owner/repo/blob/main/deployments/….json" value={source} onChange={(event) => { setSource(event.target.value); setError(undefined); }} />{error ? <small id="holder-import-error" className="field-error">{error}</small> : <small id="holder-import-help">The repository becomes a trusted policy source for this deployment. Its default branch and canonical bytes are verified.</small>}</label><button className="button primary wide" disabled={busy || !source.trim()} type="button" onClick={() => void importPublicDeployment()}>{busy ? "Verifying custom registry…" : "Import from custom GitHub"} <Upload size={16} /></button></div> : null}
            {sourceKind === "manual" ? <div className="form-stack source-entry"><label>Manifest JSON or HTTPS URL<textarea ref={sourceRef} aria-invalid={Boolean(error)} aria-describedby={error ? "holder-import-error" : "holder-import-help"} rows={10} value={source} onChange={(event) => { setSource(event.target.value); setError(undefined); }} />{error ? <small id="holder-import-error" className="field-error">{error}</small> : <small id="holder-import-help">Manual import still requires byte-identical publication in the official registry.</small>}</label><button className="button secondary wide" disabled={busy || !source.trim()} type="button" onClick={() => void importPublicDeployment()}>{busy ? "Verifying public data…" : "Verify and import manifest"}</button></div> : null}
          </>}
        </Panel>
        <aside className="flow-aside"><SafetyNote title="Source and authority">Importing trusts the selected public repository for deployment and policy bytes. It stores no issuer authority; governance requires a separate local issuer-key attachment in Issuer Setup.</SafetyNote></aside>
      </div>
  );
}

function AssetRow({ balance, deployment, regulatedFunds }: { balance: AssetBalance; deployment: Deployment; regulatedFunds?: RegulatedFunds }) {
  const regulated = balance.assetId === deployment.regulatedAsset;
  const policy = balance.assetId === deployment.policyAsset;
  const token = balance.assetId === deployment.reissuanceToken;
  const label = regulated ? deployment.asset.name : policy ? "Liquid Bitcoin" : token ? "Reissuance token" : shortHash(balance.assetId);
  const ticker = regulated ? deployment.asset.ticker : policy ? "L-BTC" : token ? "TOKEN" : "units";
  const precision = regulated ? deployment.asset.precision : policy ? 8 : 0;
  return <div><span><strong>{label}</strong><small>{shortHash(balance.assetId)}</small></span><span><strong>{regulated && regulatedFunds ? `${formatUnits(regulatedFunds.spendable, precision)} ${ticker} spendable` : `${formatUnits(balance.confirmed, precision)} ${ticker}`}</strong>{regulated && regulatedFunds?.blacklisted ? <small className="asset-blacklisted">{formatUnits(regulatedFunds.blacklisted, precision)} blacklisted — cannot be spent</small> : balance.pending > 0n ? <small>+{formatUnits(balance.pending, precision)} pending</small> : <small>{balance.confirmedUtxos} confirmed output{balance.confirmedUtxos === 1 ? "" : "s"}</small>}</span></div>;
}

function walletUtxoAsset(assetId: string, deployment: Deployment) {
  if (assetId === deployment.regulatedAsset) return { label: deployment.asset.name, ticker: deployment.asset.ticker, precision: deployment.asset.precision };
  if (assetId === deployment.policyAsset) return { label: "Liquid Bitcoin", ticker: "L-BTC", precision: 8 };
  if (assetId === deployment.reissuanceToken) return { label: "Reissuance token", ticker: "TOKEN", precision: 0 };
  return { label: "Unknown asset", ticker: "base units", precision: 0 };
}

type SendReview = SendForm & {
  recipientAddress: { confidentialAddress: string; ownerPublicKey: string };
  amountUnits: string;
  funding: TransferFundingSelection;
  policy: PolicySnapshot;
  anchor: { txid: string; confirmations: number; scriptPubkey: string };
  signerProfileId: string;
  signerFingerprint: string;
  selfSend: boolean;
};

type RecipientValidationState =
  | { status: "idle" }
  | { status: "validating"; source: string }
  | { status: "valid"; source: string; address: { confidentialAddress: string; ownerPublicKey: string } }
  | { status: "error"; source: string };

export function WalletSend() {
  const deployment = useActiveDeployment();
  const signerState = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const queryClient = useQueryClient();
  const [review, setReview] = useState<SendReview>();
  const [message, setMessage] = useState<string>();
  const [contextError, setContextError] = useState<string>();
  const [recipientValidation, setRecipientValidation] = useState<RecipientValidationState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const form = useForm<SendForm>({
    resolver: zodResolver(sendSchema),
    mode: "onChange",
    reValidateMode: "onChange",
    defaultValues: { recipient: "", amount: "" },
  });
  const signerMatchesDeployment = !deployment.data || signerState.network === deployment.data.network;
  const wallet = useDeploymentWalletSync(
    deployment.data,
    signerState.connected && signerMatchesDeployment ? signerState.profileId : undefined,
  );
  const liveState = useQuery({
    queryKey: ["transfer-preflight", deployment.data?.deploymentId],
    enabled: Boolean(deployment.data?.publication === "published"),
    staleTime: 10_000,
    queryFn: async () => {
      const selected = requirePublishedDeployment(deployment.data);
      const esplora = esploraUrlForDeployment(selected);
      const anchor = await traverseLiveAnchor(selected, esplora);
      if (anchor.live.confirmations < 1) throw new Error("The live verifier anchor is not confirmed.");
      const policy = await resolvePolicySnapshot(selected, anchor.live.scriptPubkey);
      return { anchor: anchor.live, policy };
    },
  });
  const receiptKey = operationReceiptQueryKey(deployment.data?.deploymentId, "transfer", signerState.profileId);
  const receiptQuery = useQuery({
    queryKey: receiptKey,
    enabled: Boolean(deployment.data && signerState.connected && signerState.profileId),
    queryFn: async () => (await loadOperationReceipt(deployment.data!.deploymentId, "transfer", signerState.profileId!)) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const receipt = receiptQuery.data ?? undefined;
  const broadcastInFlight = useRef(false);
  const reviewInFlight = useRef(false);
  const reviewAttempt = useRef(0);
  const recipientValidationRevision = useRef(0);
  const contextErrorRef = useRef<HTMLDivElement>(null);
  const activeDeploymentId = useRef(deployment.data?.deploymentId);
  activeDeploymentId.current = deployment.data?.deploymentId;
  const synchronizedSnapshot = wallet.data?.snapshot;
  const regulatedBalance = useMemo(() => {
    if (!deployment.data || !synchronizedSnapshot) return undefined;
    return assetBalances(synchronizedSnapshot).find((balance) => balance.assetId === deployment.data?.regulatedAsset) ?? {
      assetId: deployment.data.regulatedAsset,
      confirmed: 0n,
      pending: 0n,
      confirmedUtxos: 0,
      pendingUtxos: 0,
    };
  }, [deployment.data, synchronizedSnapshot]);
  const transferFunds = useMemo(() => deployment.data && synchronizedSnapshot && liveState.data
    ? classifyRegulatedFunds(synchronizedSnapshot, deployment.data, liveState.data.policy)
    : undefined, [deployment.data, liveState.data, synchronizedSnapshot]);

  useEffect(() => {
    reviewAttempt.current += 1;
    reviewInFlight.current = false;
    setReviewBusy(false);
    setReview(undefined);
    setMessage(undefined);
    setContextError(undefined);
    setRecipientValidation({ status: "idle" });
    recipientValidationRevision.current += 1;
    form.reset({ recipient: "", amount: "" });
  }, [deployment.data?.deploymentId, form, signerState.profileId]);

  useEffect(() => {
    const key = `transfer:${deployment.data?.deploymentId ?? "none"}:${signerState.profileId ?? "disconnected"}`;
    setSignerOperationPending(key, Boolean(review || reviewBusy || busy));
    return () => setSignerOperationPending(key, false);
  }, [busy, deployment.data?.deploymentId, review, reviewBusy, signerState.profileId]);

  function setTransferError(error: unknown, focus = false) {
    const message = userFacingError(error);
    if (error instanceof TransferValidationError && error.field !== "context") {
      form.setError(error.field, { message }, { shouldFocus: focus });
      return;
    }
    setContextError(message);
    if (focus) {
      requestAnimationFrame(() => {
        contextErrorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        contextErrorRef.current?.focus();
      });
    }
  }

  async function validateRecipientField(value: string) {
    const selected = deployment.data;
    const source = value.trim();
    const revision = ++recipientValidationRevision.current;
    if (!source || !selected || selected.publication !== "published") {
      setRecipientValidation({ status: "idle" });
      return undefined;
    }
    setRecipientValidation({ status: "validating", source });
    try {
      if (!signerState.connected || !signerState.profileId || signerState.network !== selected.network) {
        throw new TransferValidationError("context", "signer", `Connect and synchronize a ${networkLabel(selected.network)} debug signer before validating the recipient.`);
      }
      const address = await resolveAndValidateRecipientAddress(source, selected);
      if (revision !== recipientValidationRevision.current) return undefined;
      if (signerSnapshot().profileId !== signerState.profileId) {
        throw new TransferValidationError("context", "profile-changed", "The active signer profile changed while validating the recipient. Try again.");
      }
      form.clearErrors("recipient");
      setRecipientValidation({ status: "valid", source, address });
      return address;
    } catch (error) {
      if (revision !== recipientValidationRevision.current) return undefined;
      setRecipientValidation({ status: "error", source });
      setTransferError(error);
      return undefined;
    }
  }

  function validateAmountField(value: string) {
    if (!deployment.data) return;
    try {
      const amount = parseTransferAmount(value, deployment.data.asset.precision);
      form.clearErrors("amount");
      if (liveState.data?.policy && synchronizedSnapshot && signerState.profileId) {
        selectTransferFunding({ snapshot: synchronizedSnapshot, deployment: deployment.data, policy: liveState.data.policy, profileId: signerState.profileId, amount: amount.units });
      }
      setContextError(undefined);
    } catch (error) {
      setTransferError(error);
    }
  }

  async function validateRecipientOnBlur(value: string) {
    if (!await form.trigger("recipient")) {
      setRecipientValidation({ status: "idle" });
      return;
    }
    await validateRecipientField(value);
  }

  async function validateAmountOnBlur(value: string) {
    if (!await form.trigger("amount")) return;
    validateAmountField(value);
  }

  async function reviewTransfer(values: SendForm) {
    if (reviewInFlight.current) return;
    if (hasPendingSignerOperation()) {
      setContextError("Another signer operation is still pending. Finish or cancel it before reviewing this transfer.");
      return;
    }
    const attempt = ++reviewAttempt.current;
    reviewInFlight.current = true;
    setReviewBusy(true);
    setMessage(undefined);
    setContextError(undefined);
    const reviewProfileId = signerState.profileId;
    try {
      const selected = requirePublishedDeployment(deployment.data);
      if (!signerState.connected || !reviewProfileId || !signerState.fingerprint) {
        throw new TransferValidationError("context", "signer", "Connect a test-only debug signer before reviewing a transfer.");
      }
      if (signerState.network !== selected.network) {
        throw new TransferValidationError("context", "network", `Switch to a ${networkLabel(selected.network)} signer profile.`);
      }
      if (!signerState.walletReady) {
        throw new TransferValidationError("context", "sync", "Wait for a successful wallet synchronization before reviewing a transfer.", true);
      }
      const amount = parseTransferAmount(values.amount, selected.asset.precision);
      let recipientAddress = recipientValidation.status === "valid" && recipientValidation.source === values.recipient.trim()
        ? recipientValidation.address
        : undefined;
      recipientAddress ??= await resolveAndValidateRecipientAddress(values.recipient, selected);
      setRecipientValidation({ status: "valid", source: values.recipient.trim(), address: recipientAddress });
      const [walletResult, liveResult, ownAddress] = await Promise.all([
        wallet.refetch(),
        liveState.refetch(),
        ensureSignerHolderAddress(selected, reviewProfileId),
      ]);
      if (attempt !== reviewAttempt.current || activeDeploymentId.current !== selected.deploymentId) return;
      if (walletResult.error || !walletResult.data?.snapshot || walletResult.data.syncError) {
        throw new TransferValidationError("context", "wallet-sync", walletResult.data?.syncError ?? userFacingError(walletResult.error ?? "Wallet synchronization did not return a verified snapshot."), true);
      }
      if (liveResult.error || !liveResult.data) {
        throw new TransferValidationError("context", "policy-sync", `Could not verify the current policy and anchor: ${userFacingError(liveResult.error)}`, true);
      }
      const funding = selectTransferFunding({
        snapshot: walletResult.data.snapshot,
        deployment: selected,
        policy: liveResult.data.policy,
        profileId: reviewProfileId,
        amount: amount.units,
      });
      if (signerSnapshot().profileId !== reviewProfileId) {
        throw new TransferValidationError("context", "profile-changed", "The active signer profile changed during validation. Review again.");
      }
      setReview({
        ...values,
        amount: amount.normalized,
        amountUnits: amount.units.toString(),
        recipientAddress,
        funding,
        policy: liveResult.data.policy,
        anchor: liveResult.data.anchor,
        signerProfileId: reviewProfileId,
        signerFingerprint: signerState.fingerprint,
        selfSend: ownAddress.ownerPublicKey === recipientAddress.ownerPublicKey,
      });
    } catch (error) {
      if (attempt === reviewAttempt.current) setTransferError(error, true);
    } finally {
      if (attempt === reviewAttempt.current) {
        reviewInFlight.current = false;
        setReviewBusy(false);
      }
    }
  }

  async function send() {
    if (!tryBeginOperation(broadcastInFlight, receipt)) return;
    setBusy(true);
    setMessage(undefined);
    setContextError(undefined);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      if (!review) throw new Error("Review the transfer first.");
      const amount = parseTransferAmount(review.amount, selected.asset.precision);
      if (amount.units.toString() !== review.amountUnits) {
        throw new TransferValidationError("context", "amount-changed", "The reviewed amount changed. Review the transfer again.");
      }
      const recipient = await resolveAndValidateRecipientAddress(review.recipientAddress.confidentialAddress, selected);
      if (recipient.ownerPublicKey !== review.recipientAddress.ownerPublicKey) {
        throw new TransferValidationError("context", "recipient-changed", "The reviewed recipient changed. Review the transfer again.");
      }
      const esplora = esploraUrlForDeployment(selected);
      const signer = signerSnapshot();
      if (!signer.connected || !signer.profileId || !signer.walletReady) {
        throw new TransferValidationError("context", "signer", "The active signer must be connected and freshly synchronized before signing.", true);
      }
      if (signer.profileId !== review.signerProfileId || signer.network !== selected.network) {
        throw new TransferValidationError("context", "profile-changed", "The active signer profile or network changed. Review the transfer again.");
      }
      const [anchor, wallet] = await Promise.all([
        traverseLiveAnchor(selected, esplora),
        synchronizeDeploymentWallet(selected, signer.profileId),
      ]);
      if (anchor.live.confirmations < 1) throw new Error("The live verifier anchor is not confirmed.");
      const policy = await resolvePolicySnapshot(selected, anchor.live.scriptPubkey);
      const verifierUtxo = await liveAnchorUtxo(selected, anchor.live.txid);
      const funding = selectTransferFunding({ snapshot: wallet, deployment: selected, policy, profileId: signer.profileId, amount: amount.units });
      const reviewedRegulated = review.funding.regulatedUtxos.map((utxo) => `${utxo.txid}:${utxo.vout}`).join(",");
      const currentRegulated = funding.regulatedUtxos.map((utxo) => `${utxo.txid}:${utxo.vout}`).join(",");
      const reviewedFees = review.funding.feeUtxos.map((utxo) => `${utxo.txid}:${utxo.vout}`).join(",");
      const currentFees = funding.feeUtxos.map((utxo) => `${utxo.txid}:${utxo.vout}`).join(",");
      if (
        anchor.live.txid !== review.anchor.txid
        || anchor.live.scriptPubkey !== review.anchor.scriptPubkey
        || policy.policyRoot !== review.policy.policyRoot
        || funding.fee !== review.funding.fee
        || funding.regulatedChange !== review.funding.regulatedChange
        || currentRegulated !== reviewedRegulated
        || currentFees !== reviewedFees
      ) {
        throw new TransferValidationError("context", "state-changed", "Wallet, fee, policy, or anchor state changed after review. Review the transfer again.", true);
      }
      await requireFreshAnchor(selected, anchor.live, esplora);
      const signingProfile = signerSnapshot();
      if (
        !signingProfile.connected
        || !signingProfile.walletReady
        || signingProfile.profileId !== signer.profileId
        || signingProfile.network !== selected.network
      ) {
        throw new TransferValidationError("context", "profile-changed", "The active signer profile changed immediately before signing. Review the transfer again.");
      }
      if (activeDeploymentId.current !== selected.deploymentId) {
        throw new TransferValidationError("context", "deployment-changed", "The active deployment changed immediately before signing. Review the transfer again.");
      }
      const result = await signTransfer({
        deployment: publicManifest(selected),
        currentPolicy: policy,
        verifierUtxo,
        regulatedUtxos: funding.regulatedUtxos,
        feeUtxos: funding.feeUtxos,
        recipientAddress: recipient.confidentialAddress,
        amount: amount.units.toString(),
        fee: funding.fee.toString(),
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
        amount: amount.units.toString(),
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
      if (error instanceof TransferValidationError) setReview(undefined);
      setTransferError(error, true);
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
    setContextError(undefined);
    setRecipientValidation({ status: "idle" });
    form.reset({ recipient: "", amount: "" });
  }

  const recipientField = form.register("recipient");
  const amountField = form.register("amount");
  const walletError = wallet.data?.syncError ?? (wallet.error instanceof Error ? wallet.error.message : undefined);
  const signerReady = Boolean(
    signerState.connected
    && signerState.profileId
    && signerState.walletReady
    && signerMatchesDeployment,
  );
  const walletReady = Boolean(synchronizedSnapshot && !walletError && !wallet.isPending && !wallet.isFetching);
  const hasSpendableFunds = Boolean(transferFunds && transferFunds.spendable > 0n);
  const policyReady = Boolean(liveState.data && !liveState.error && !liveState.isPending && !liveState.isFetching);
  const recipientValidating = recipientValidation.status === "validating";
  const canReview = form.formState.isValid
    && signerReady
    && walletReady
    && policyReady
    && recipientValidation.status === "valid"
    && recipientValidation.source === form.getValues("recipient").trim()
    && !contextError
    && !reviewBusy
    && hasSpendableFunds;

  return (
    <AppShell eyebrow="Holder wallet / Send" title="Build a regulated transfer">
      <BackLink to="/wallet">Back to wallet</BackLink>
      <div className="flow-layout">
        <Panel className="flow-main">
          <SectionHeading label={receipt ? "Receipt" : review ? "Review" : "Recipient and amount"} title={receipt ? "Transfer broadcast" : review ? "Confirm transfer details" : "Who are you paying?"} />
          {!deployment.data ? <p>Import or select a deployment first.</p> : deployment.data.publication !== "published" ? <div className="generate-record"><ShieldCheck size={26} /><p>This deployment is confirmed, but canonical registry publication is still pending. Transfers remain disabled until its manifest and live D4 policy are byte-identical on the registry default branch.</p><Link className="button primary" to="/admin/setup">Finish registry publication</Link></div> : receipt ? <OperationReceiptPanel receipt={receipt} network={deployment.data.network} amountLabel={`${formatUnits(receipt.amount, deployment.data.asset.precision)} ${receipt.ticker}`} resetLabel="Start a new transfer" tone="holder" onReset={() => void startNewTransfer()} /> : !review ? (
            <form onSubmit={form.handleSubmit(reviewTransfer)} className="form-stack">
              {transferFunds && transferFunds.blacklisted > 0n ? <div className={`blacklist-warning ${transferFunds.spendable === 0n ? "full" : "partial"}`} role={transferFunds.spendable === 0n ? "alert" : "status"}><AlertTriangle size={18} /><div><strong>{transferFunds.spendable === 0n ? "All confirmed funds are blacklisted" : "Some confirmed funds are blacklisted"}</strong><p>{formatUnits(transferFunds.blacklisted, deployment.data.asset.precision)} {deployment.data.asset.ticker} cannot be spent. {formatUnits(transferFunds.spendable, deployment.data.asset.precision)} {deployment.data.asset.ticker} remains spendable.</p></div></div> : null}
              <label>Recipient confidential address<input aria-invalid={Boolean(form.formState.errors.recipient)} aria-describedby={form.formState.errors.recipient ? "send-recipient-error" : "send-recipient-help"} autoCapitalize="none" autoCorrect="off" spellCheck={false} {...recipientField} onChange={(event) => { recipientField.onChange(event); recipientValidationRevision.current += 1; setRecipientValidation({ status: "idle" }); setContextError(undefined); if (event.target.value.trim()) form.clearErrors("recipient"); }} onBlur={(event) => { recipientField.onBlur(event); void validateRecipientOnBlur(event.target.value); }} />{form.formState.errors.recipient ? <small id="send-recipient-error" className="field-error">{form.formState.errors.recipient.message}</small> : <small id="send-recipient-help">{recipientValidation.status === "validating" ? "Checking network and holder covenant…" : recipientValidation.status === "valid" ? "Address verified for the selected DAMP covenant." : "Paste the confidential address copied from the recipient's Receive screen."}</small>}</label>
              <label>Amount<div className="amount-input"><input aria-invalid={Boolean(form.formState.errors.amount)} aria-describedby={form.formState.errors.amount ? "send-amount-error" : "send-amount-help"} inputMode="decimal" {...amountField} onChange={(event) => { amountField.onChange(event); setContextError(undefined); if (event.target.value.trim()) form.clearErrors("amount"); }} onBlur={(event) => { amountField.onBlur(event); void validateAmountOnBlur(event.target.value); }} /><span>{deployment.data.asset.ticker}</span></div>{form.formState.errors.amount ? <small id="send-amount-error" className="field-error">{form.formState.errors.amount.message}</small> : <small id="send-amount-help">{transferFunds && regulatedBalance ? `${formatUnits(transferFunds.spendable, deployment.data.asset.precision)} spendable · ${formatUnits(transferFunds.blacklisted, deployment.data.asset.precision)} blacklisted · ${formatUnits(regulatedBalance.pending, deployment.data.asset.precision)} pending` : "Spendable balance appears only after wallet and live-policy verification."}</small>}</label>
              <div className="transfer-readiness" aria-label="Transfer readiness">
                <div><span>Deployment</span><Pill tone="good">Published + canonical</Pill></div>
                <div><span>Signer profile</span><Pill tone={signerReady ? "good" : "warn"}>{signerReady ? "Connected + synced" : "Action needed"}</Pill></div>
                <div><span>Wallet funds</span><Pill tone={walletReady && hasSpendableFunds ? "good" : walletReady || walletError ? "warn" : "blue"}>{walletReady ? hasSpendableFunds ? "Spendable asset ready" : "No spendable asset" : walletError ? "Sync error" : "Synchronizing"}</Pill></div>
                <div><span>Live policy + anchor</span><Pill tone={policyReady ? "good" : liveState.error ? "warn" : "blue"}>{policyReady ? `D${liveState.data!.policy.treeDepth} current` : liveState.error ? "Check failed" : "Checking"}</Pill></div>
              </div>
              {(contextError || walletError || liveState.error) && <div className="transfer-error-summary" role="alert" tabIndex={-1} ref={contextErrorRef}><strong>Transfer is not ready</strong><p>{contextError ?? walletError ?? userFacingError(liveState.error)}</p><div><button className="button secondary" type="button" disabled={wallet.isFetching} onClick={() => void wallet.refetch()}>Refresh wallet</button><button className="button secondary" type="button" disabled={liveState.isFetching} onClick={() => void liveState.refetch()}>Recheck policy</button></div></div>}
              <button className="button primary wide" disabled={!canReview} type="submit">{reviewBusy || recipientValidating ? "Validating transfer…" : "Review transfer"} <ArrowRight size={16} /></button>
            </form>
          ) : (
            <div className="review-stack">
              <ReviewRow label="Recipient" value={<CopyableAddress address={review.recipientAddress.confidentialAddress} resetKey={`${review.signerProfileId}:${deployment.data.network}:${review.recipientAddress.ownerPublicKey}`} accessibleLabel="Copy reviewed recipient address" display={shortHash(review.recipientAddress.confidentialAddress, 12, 8)} onNotice={(notice) => setMessage(notice.message)} />} />
              <ReviewRow label="Amount" value={`${review.amount} ${deployment.data.asset.ticker} · ${review.amountUnits} base units`} />
              <ReviewRow label="Asset" value={`${deployment.data.asset.ticker} · ${shortHash(deployment.data.regulatedAsset, 12, 10)}`} />
              <ReviewRow label="Network fee" value={`${formatUnits(review.funding.fee, 8)} L-BTC · ${review.funding.fee} satoshis`} />
              <ReviewRow label="Regulated change" value={`${formatUnits(review.funding.regulatedChange, deployment.data.asset.precision)} ${deployment.data.asset.ticker}`} />
              <ReviewRow label="Deployment" value={shortHash(deployment.data.deploymentId, 12, 10)} good />
              <ReviewRow label="Policy" value={`D${review.policy.treeDepth} · ${shortHash(review.policy.policyRoot, 12, 10)}`} good />
              <ReviewRow label="Live anchor" value={`${shortHash(review.anchor.txid, 12, 10)} · ${review.anchor.confirmations} confirmation${review.anchor.confirmations === 1 ? "" : "s"}`} good />
              <ReviewRow label="Signer profile" value={`${review.signerFingerprint} · ${shortHash(review.signerProfileId, 18, 8)}`} />
              <ReviewRow label="Network" value={networkLabel(deployment.data.network)} />
              {review.selfSend && <p className="inline-message" role="status">This address belongs to the active signer profile. Signing will create a deliberate self-transfer.</p>}
              <div className="review-buttons"><button className="button secondary" disabled={busy} type="button" onClick={() => setReview(undefined)}>Edit</button><button className="button primary" aria-busy={busy} disabled={busy || receiptQuery.isPending || !signerState.walletReady} type="button" onClick={send}>{busy ? "Signing and broadcasting…" : !signerState.walletReady ? "Sync wallet before signing" : "Sign and broadcast"} <ArrowRight size={16} /></button></div>
            </div>
          )}
          {message && <p className="inline-message" role="status">{message}</p>}
        </Panel>
        <aside className="flow-aside"><Panel><h3>Transaction rules</h3><ul className="check-list"><li><Check size={15} /> Verifier at input/output 0</li><li><Check size={15} /> Holder at input 1</li><li><Check size={15} /> At most ten regulated inputs/outputs</li><li><Check size={15} /> Explicit regulated assets and amounts</li></ul><p className="technical-note">Address validation proves compatibility with the selected covenant. It does not prove which deployment manifest the recipient trusts.</p></Panel></aside>
      </div>
    </AppShell>
  );
}

function ReviewRow({ label, value, good }: { label: string; value: ReactNode; good?: boolean }) {
  return <div className="review-row"><span>{label}</span><div className="review-row-value">{value} {good && <Check size={14} />}</div></div>;
}

export function WalletReceive() {
  const deployment = useActiveDeployment();
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string>();
  const storedRecords = useQuery({
    queryKey: ["holder-address", deployment.data?.deploymentId, signer.profileId],
    enabled: Boolean(deployment.data && signer.connected && signer.profileId),
    queryFn: () => ensureSignerHolderAddress(requireDeployment(deployment.data), signer.profileId!),
  });
  const address = storedRecords.data?.confidentialAddress;

  async function generate() {
    try {
      const selected = requireDeployment(deployment.data);
      if (!signer.connected || !signer.profileId) throw new Error("Connect the DAMP signer first.");
      const created = await ensureSignerHolderAddress(selected, signer.profileId);
      queryClient.setQueryData(["holder-address", selected.deploymentId, signer.profileId], created);
    } catch (error) {
      setMessage(userFacingError(error));
    }
  }

  return (
    <AppShell eyebrow="Holder wallet / Receive" title="Receive regulated assets">
      <BackLink to="/wallet">Back to wallet</BackLink>
      <div className="receive-layout">
        <Panel className="receive-card"><SectionHeading label="Confidential holder address" title="Share this address with the sender" />{!deployment.data ? <div className="generate-record"><Radio size={26} /><p>No deployment is selected. Select a deployment before deriving its holder address.</p><Link className="button primary" to="/admin/setup">Open Setup</Link></div> : address ? <><div className="qr-wrap"><QRCodeSVG value={address} size={188} level="M" /></div><CopyableAddress address={address} resetKey={`${signer.profileId}:${deployment.data.deploymentId}:${storedRecords.data?.derivationIndex ?? "unknown"}`} accessibleLabel="Copy confidential receive address" display={address} className="receive-address" onNotice={(notice) => setMessage(notice.message)} /></> : <div className="generate-record"><Radio size={26} /><p>Connect the signer to derive the confidential holder address for this deployment.</p><button className="button primary" disabled={!signer.connected || storedRecords.isFetching} type="button" onClick={generate}>{storedRecords.isFetching ? "Deriving…" : "Derive address"}</button></div>}{storedRecords.error instanceof Error && <p className="field-error">{storedRecords.error.message}</p>}{message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}</Panel>
        <div className="receive-notes"><SafetyNote title="Share only this address">The sender checks its network and holder covenant before building a transfer. Your recovery phrase and private keys never leave this device.</SafetyNote><Panel><h3>Sender checks</h3><ul className="check-list"><li><ShieldCheck size={15} /> Confidential address</li><li><ShieldCheck size={15} /> Correct network</li><li><ShieldCheck size={15} /> Selected holder covenant</li></ul></Panel></div>
      </div>
    </AppShell>
  );
}
