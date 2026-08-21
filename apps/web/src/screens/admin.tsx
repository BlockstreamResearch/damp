import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AlertTriangle, ArrowRight, Check, ClipboardCopy, Download, ExternalLink, Fuel, GitPullRequest, ListFilter, Minus, Plus, RefreshCw, Rocket, ShieldCheck, Trash2, Upload } from "lucide-react";

import { AppShell, BackLink, Panel, Pill, SafetyNote, SectionHeading, TechnicalDetails, WalletStatus } from "../components/ui";
import {
  bootstrap as bootstrapDeployment,
  buildBlacklist,
  deriveAmpKey,
  deriveWalletAddress,
  reissue,
  signerSnapshot,
  signPolicyUpdate,
  subscribeSigner,
  validateDeployment,
  validatePolicySnapshot,
  validateReceiveRecord,
  validateReceiveRecordShape,
  type DerivedWalletAddress,
} from "../lib/amp-signer";
import {
  broadcastTransaction,
  liveAnchorUtxo,
} from "../lib/chain-wallet";
import {
  deploymentQueryKeys,
  useActiveDeployment,
} from "../lib/deployments";
import {
  blacklistEntrySchema,
  deploymentManifestSchema,
  formatUnits,
  localDeploymentSchema,
  policySnapshotSchema,
  publicManifest,
  receiveRecordSchema,
  requireDeployment,
  requirePublishedDeployment,
  shortHash,
  smallestTreeDepth,
  userFacingError,
  type BlacklistEntry,
  type Deployment,
  type DeploymentManifest,
  type PolicySnapshot,
} from "../lib/domain";
import { AnchorConflictError, esploraUrlForDeployment, isRetryableEsploraRequest, requireFreshAnchor, traverseLiveAnchor } from "../lib/esplora";
import { liquidTestnetFaucetUrl, nativeFeeAssetId } from "../lib/faucet";
import {
  canonicalRegistryContent,
  copyCanonicalRegistryFile,
  deploymentRegistryPath,
  downloadCanonicalRegistryFile,
  registryPathForVerifierScript,
  registryRepositoryUrl,
  verifyCanonicalRegistryFile,
} from "../lib/github";
import { buildSuccessorPolicy, resolvePolicySnapshot, sha256Hex } from "../lib/policy-registry";
import { useBaseWalletSync, walletSyncQueryKeys } from "../lib/wallet-query";
import {
  ensureSignerReceiveRecord,
  issuanceFundingPlan,
  selectSpendableUtxos,
  synchronizeBaseWallet,
  synchronizeDeploymentWallet,
} from "../lib/wallet-sync";
import {
  getDraft,
  putDeployment,
  putDraft,
  putPolicySnapshot,
  putReceiveRecord,
  setActiveDeploymentId,
} from "../lib/store";

const entryFormSchema = z.object({
  outpoint: z.string().regex(/^[0-9a-f]{64}:[0-9]+$/, "Use exact lowercase txid:vout format"),
  note: z.string().trim().max(280).optional(),
});
type EntryForm = z.infer<typeof entryFormSchema>;

function useLivePolicy(deployment: Deployment | null | undefined) {
  const anchor = useQuery({
    queryKey: ["anchor", deployment?.deploymentId],
    enabled: Boolean(deployment),
    queryFn: () => traverseLiveAnchor(requireDeployment(deployment), esploraUrlForDeployment(requireDeployment(deployment))),
  });
  const policy = useQuery({
    queryKey: ["policy", deployment?.deploymentId, anchor.data?.live.scriptPubkey],
    enabled: Boolean(deployment && anchor.data),
    queryFn: () => resolvePolicySnapshot(requireDeployment(deployment), anchor.data!.live.scriptPubkey),
  });
  return { anchor, policy };
}

export function AdminDashboard() {
  const deployment = useActiveDeployment();
  const { anchor, policy } = useLivePolicy(deployment.data);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BlacklistEntry[]>([]);
  const [loadedPolicy, setLoadedPolicy] = useState<string>();
  const [pending, setPending] = useState<PolicySnapshot>();
  const [pendingPath, setPendingPath] = useState<string>();
  const [reviewUpdate, setReviewUpdate] = useState(false);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = useForm<EntryForm>({ resolver: zodResolver(entryFormSchema) });

  useEffect(() => {
    const current = policy.data;
    const selected = deployment.data;
    if (!current || !selected || loadedPolicy === current.policyRoot) return;
    setLoadedPolicy(current.policyRoot);
    void Promise.all([
      getDraft<BlacklistEntry[]>(selected.deploymentId, "blacklist"),
      getDraft<PolicySnapshot>(selected.deploymentId, "pending-policy"),
    ]).then(([stored, storedPending]) => {
      setDraft(stored ?? current.entries);
      if (storedPending?.parentPolicyRoot === current.policyRoot) {
        setPending(storedPending);
        void registryPathForVerifierScript(selected.deploymentId, storedPending.verifierScriptPubkey).then(setPendingPath);
      } else {
        setPending(undefined);
        setPendingPath(undefined);
      }
    });
  }, [deployment.data, loadedPolicy, policy.data]);

  useEffect(() => {
    if (deployment.data && loadedPolicy) void putDraft(deployment.data.deploymentId, "blacklist", draft);
  }, [deployment.data, draft, loadedPolicy]);

  useEffect(() => {
    const selected = deployment.data;
    const live = anchor.data?.live;
    if (!selected || !live) return;
    const activeAnchor = `${live.txid}:0`;
    const confirmations = selected.activeAnchor === activeAnchor
      ? Math.max(selected.confirmations, live.confirmations)
      : live.confirmations;
    if (selected.activeAnchor === activeAnchor && selected.confirmations === confirmations) return;
    void putDeployment({ ...selected, activeAnchor, confirmations })
      .then(() => queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }));
  }, [anchor.data?.live, deployment.data, queryClient]);

  const depth = smallestTreeDepth(draft.length);
  const preview = useQuery({
    queryKey: ["policy-preview", deployment.data?.deploymentId, depth, draft],
    enabled: Boolean(deployment.data),
    queryFn: () => buildBlacklist(draft, depth),
  });
  const changes = useMemo(() => {
    const key = (entry: BlacklistEntry) => `${entry.txid}:${entry.vout}`;
    const current = new Set((policy.data?.entries ?? []).map(key));
    const next = new Set(draft.map(key));
    return { added: draft.filter((entry) => !current.has(key(entry))).length, removed: (policy.data?.entries ?? []).filter((entry) => !next.has(key(entry))).length };
  }, [draft, policy.data]);
  const activeOutpoints = useMemo(
    () => new Set((policy.data?.entries ?? []).map((entry) => `${entry.txid}:${entry.vout}`)),
    [policy.data?.entries],
  );

  function addEntry(value: EntryForm) {
    const [txid, output] = value.outpoint.split(":");
    const entry = blacklistEntrySchema.parse({ txid, vout: Number(output), note: value.note || undefined });
    if (draft.some((candidate) => candidate.txid === entry.txid && candidate.vout === entry.vout)) {
      form.setError("outpoint", { message: "That exact outpoint is already present" });
      return;
    }
    setDraft((entries) => [...entries, entry].sort((left, right) => left.txid.localeCompare(right.txid) || left.vout - right.vout));
    form.reset();
  }

  async function downloadPolicySnapshot() {
    setBusy(true);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      const current = policy.data;
      if (!current) throw new Error("Resolve the canonical live policy first.");
      const successor = await buildSuccessorPolicy(selected, current, draft);
      const path = await registryPathForVerifierScript(selected.deploymentId, successor.verifierScriptPubkey);
      const downloaded = downloadCanonicalRegistryFile(path, successor);
      setPending(successor);
      setPendingPath(path);
      setReviewUpdate(false);
      await putDraft(selected.deploymentId, "pending-policy", successor);
      setMessage(`Downloaded ${downloaded.filename}. Add it at ${path}, merge it into the default branch, then activate.`);
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyPendingPolicySnapshot() {
    if (!pending || !pendingPath) return;
    try {
      await copyCanonicalRegistryFile(pendingPath, pending);
      setMessage(`Copied the exact successor snapshot bytes for ${pendingPath}.`);
    } catch (error) {
      setMessage(userFacingError(error));
    }
  }

  async function activate() {
    setBusy(true);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      const current = policy.data;
      const originalAnchor = anchor.data;
      const successor = pending ?? await getDraft<PolicySnapshot>(selected.deploymentId, "pending-policy");
      if (!current || !originalAnchor || !successor) throw new Error("Download a successor snapshot first.");
      const path = await registryPathForVerifierScript(selected.deploymentId, successor.verifierScriptPubkey);
      await verifyCanonicalRegistryFile(path, successor);
      const esplora = esploraUrlForDeployment(selected);
      await requireFreshAnchor(selected, originalAnchor.live, esplora);
      const signer = signerSnapshot();
      if (!signer.connected || !signer.fingerprint) throw new Error("Connect the AMP signer first.");
      const [verifierUtxo, wallet] = await Promise.all([
        liveAnchorUtxo(selected, originalAnchor.live.txid),
        synchronizeDeploymentWallet(selected, signer.fingerprint),
      ]);
      const fees = selectSpendableUtxos(wallet, selected.policyAsset, "wallet");
      await requireFreshAnchor(selected, originalAnchor.live, esplora);
      if (selected.issuerDerivationIndex === undefined) {
        throw new Error("This deployment has no local issuer-key locator.");
      }
      const result = await signPolicyUpdate({
        deployment: publicManifest(selected),
        currentPolicy: current,
        successorPolicy: successor,
        verifierUtxo,
        feeUtxos: fees,
        fee: "1500",
        issuerDerivationIndex: selected.issuerDerivationIndex,
      });
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      setMessage(`Policy update ${result.txid} broadcast. Waiting for the confirmed successor anchor…`);
      const winning = await waitForAnchor(selected, successor.verifierScriptPubkey);
      await putDeployment({ ...selected, activeAnchor: `${winning.live.txid}:0`, confirmations: winning.live.confirmations });
      await putPolicySnapshot(successor, await sha256Hex(successor.verifierScriptPubkey));
      setPending(undefined);
      setPendingPath(undefined);
      setReviewUpdate(false);
      setLoadedPolicy(undefined);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["anchor", selected.deploymentId] }), queryClient.invalidateQueries({ queryKey: ["policy", selected.deploymentId] }), queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }), queryClient.invalidateQueries({ queryKey: walletSyncQueryKeys.wallet(signer.fingerprint, selected.network) })]);
      setMessage(`Policy ${successor.sequence} active at ${winning.live.txid}:0.`);
    } catch (error) {
      if (error instanceof AnchorConflictError && deployment.data) {
        setPending(undefined);
        setPendingPath(undefined);
        setReviewUpdate(false);
        await putDraft(deployment.data.deploymentId, "pending-policy", null);
      }
      setMessage(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }

  const selected = deployment.data;
  return (
    <AppShell eyebrow="Issuer console" title="Exact-outpoint blacklist" action={<WalletStatus />}>
      {!selected ? <div className="empty-state"><ListFilter size={24} /><h2>No active deployment</h2><p>Create or import one before editing policy.</p></div> : selected.publication !== "published" ? <div className="empty-state"><ShieldCheck size={24} /><h2>Registry publication pending</h2><p>The confirmed deployment is visible, but blacklist governance remains locked until its manifest and D4 snapshot match the canonical default branch.</p><Link className="button issuer-primary" to="/admin/setup">Finish registry publication</Link></div> : <>
        <div className="admin-status-strip"><div><span className="status-light" /><span><small>Deployment</small><strong>{selected.asset.name}</strong></span></div><div><small>Live anchor</small><strong>{anchor.data ? shortHash(anchor.data.live.txid) : "Resolving…"}</strong></div><div><small>Depth / capacity</small><strong>D{policy.data?.treeDepth ?? "–"} / {policy.data ? 2 ** policy.data.treeDepth : "–"}</strong></div><Pill tone={anchor.data?.live.confirmations ? "good" : "warn"}>{anchor.data?.live.confirmations ?? 0} confirmations</Pill></div>
        <div className="admin-grid">
          <Panel className="policy-editor"><SectionHeading label="Policy entries" title={`${draft.length} exact outpoint${draft.length === 1 ? "" : "s"}`} aside={<Pill tone={changes.added || changes.removed ? "warn" : "neutral"}>{changes.added + changes.removed} changes</Pill>} />
            <form className="inline-add-form" onSubmit={form.handleSubmit(addEntry)}><label>Exact outpoint<input placeholder="txid:vout" spellCheck={false} {...form.register("outpoint")} /></label><label>Internal note <span>(not consensus)</span><input {...form.register("note")} /></label><button className="button issuer-primary" type="submit"><Plus size={16} /> Add</button>{form.formState.errors.outpoint && <small className="field-error form-wide">{form.formState.errors.outpoint.message}</small>}</form>
            <div className="blacklist-table" role="table"><div className="table-head" role="row"><span>Outpoint</span><span>Note</span><span>State</span><span /></div>{draft.map((entry) => { const active = activeOutpoints.has(`${entry.txid}:${entry.vout}`); return <div className="table-row" role="row" key={`${entry.txid}:${entry.vout}`}><code>{shortHash(entry.txid, 10, 8)}:{entry.vout}</code><span>{entry.note ?? "—"}</span><span><Pill tone={active ? "good" : "neutral"}>{active ? "Active" : "Draft"}</Pill></span><button aria-label="Remove outpoint" className="icon-button" type="button" onClick={() => setDraft((entries) => entries.filter((candidate) => candidate !== entry))}><Trash2 size={15} /></button></div>; })}{draft.length === 0 && <div className="table-empty"><ListFilter size={20} /> Empty blacklist.</div>}</div>
          </Panel>
          <aside className="policy-sidebar"><Panel><SectionHeading label="Iterative capacity" title={`Depth ${depth} · ${2 ** depth} entries`} /><div className="diff-counts"><div><Plus size={15} /><span><strong>{changes.added}</strong> added</span></div><div><Minus size={15} /><span><strong>{changes.removed}</strong> removed</span></div></div><div className="root-preview"><small>Next policy digest</small><code>{preview.data ? shortHash(preview.data.policyRoot, 12, 10) : "Calculating…"}</code></div><button className="button secondary wide" type="button" onClick={() => setDraft(policy.data?.entries ?? [])}>Discard draft</button></Panel><SafetyNote title="Two-phase activation">The exact immutable snapshot must be retrievable from the canonical default branch before the local signer authorizes governance.</SafetyNote></aside>
        </div>
        <Panel className="publish-flow">
          <SectionHeading label="Manual publication" title="Move this draft on chain" />
          <div className="publish-steps">
            <div><span>1</span><div><strong>Download snapshot</strong><small>D{depth}, exact canonical bytes</small></div><button className="button secondary" disabled={busy || !(changes.added || changes.removed)} type="button" onClick={downloadPolicySnapshot}><Download size={15} /> Download JSON</button></div>
            <div><span>2</span><div><strong>Add and merge the file</strong><small title={pendingPath}>{pendingPath ?? "Download to calculate its exact path"}</small></div><div className="publish-step-actions"><button className="button secondary" disabled={!pending} type="button" onClick={() => void copyPendingPolicySnapshot()}><ClipboardCopy size={15} /> Copy JSON</button><a className="button secondary" href={registryRepositoryUrl} target="_blank" rel="noreferrer"><GitPullRequest size={15} /> Open repository</a></div></div>
            <div><span>3</span><div><strong>Verify and activate</strong><small>Checks exact merged bytes and the live anchor</small></div><button className="button issuer-primary" disabled={busy || !pending} type="button" onClick={() => setReviewUpdate(true)}>Review update <ArrowRight size={15} /></button></div>
          </div>
          {reviewUpdate && pending && <div className="review-stack" aria-label="Policy update review">
            <div className="review-row"><span>Policy sequence</span><strong>{policy.data?.sequence ?? "–"} → {pending.sequence}</strong></div>
            <div className="review-row"><span>Blacklist</span><strong>{pending.entryCount} exact outpoint{pending.entryCount === 1 ? "" : "s"} · D{pending.treeDepth}</strong></div>
            <div className="review-row"><span>Current anchor</span><strong>{anchor.data ? `${shortHash(anchor.data.live.txid)}:0` : "Resolving…"}</strong></div>
            <div className="review-row"><span>Network fee</span><strong>0.000015 L-BTC</strong></div>
            <div className="review-buttons"><button className="button secondary" disabled={busy} type="button" onClick={() => setReviewUpdate(false)}>Back</button><button className="button issuer-primary" disabled={busy} type="button" onClick={() => void activate()}>{busy ? "Validating and signing…" : "Sign and activate"} <ArrowRight size={15} /></button></div>
          </div>}
          {message && <p className="inline-message" role="status">{message}</p>}
        </Panel>
        <TechnicalDetails label="Policy commitment details"><dl className="detail-grid"><div><dt>Policy profile</dt><dd>Blacklist non-membership only</dd></div><div><dt>Key</dt><dd>SHA256(consensus_txid || big_endian(vout))</dd></div><div><dt>Supported depths</dt><dd>4, 5, 6</dd></div><div><dt>PoC transaction limit</dt><dd>10 regulated inputs and outputs</dd></div></dl></TechnicalDetails>
      </>}
    </AppShell>
  );
}

async function waitForAnchor(deployment: Deployment, expectedScript: string) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    try {
      const anchor = await traverseLiveAnchor(deployment, esploraUrlForDeployment(deployment));
      if (anchor.live.scriptPubkey === expectedScript && anchor.live.confirmations > 0) return anchor;
    } catch (error) {
      if (!isRetryableEsploraRequest(error)) throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 5_000));
  }
  throw new Error("Timed out waiting for the confirmed successor anchor.");
}

const setupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ticker: z.string().trim().min(1).max(12),
  precision: z.number().int().min(0).max(8),
  supply: z.string().regex(/^[1-9][0-9]*$/),
  supplyMode: z.enum(["fixed", "issuer-managed"]),
  network: z.enum(["liquid-testnet", "elements-regtest"]),
});
type SetupForm = z.infer<typeof setupSchema>;
type BootstrapConfiguration = SetupForm & { policyAsset: string };
const bootstrapRecoverySchema = setupSchema.extend({
  protocol: z.literal("simplicity-amp/v0.1"),
  deploymentSalt: z.string().regex(/^[0-9a-f]{64}$/),
  policyAsset: z.string().regex(/^[0-9a-f]{64}$/),
  fundingAddresses: z.array(z.string().min(20)).length(2),
}).strict();

type BootstrapState = { deployment: Deployment; snapshot: PolicySnapshot };
type BootstrapRegistryFiles = { manifestPath: string; snapshotPath: string };

export function AdminSetup() {
  const queryClient = useQueryClient();
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const activeDeployment = useActiveDeployment();
  const [mode, setMode] = useState<"choose" | "create" | "import">("choose");
  const [configuration, setConfiguration] = useState<BootstrapConfiguration>();
  const [salt, setSalt] = useState<string>();
  const [bootstrapped, setBootstrapped] = useState<BootstrapState>();
  const [registryFiles, setRegistryFiles] = useState<BootstrapRegistryFiles>();
  const [fundingAddresses, setFundingAddresses] = useState<DerivedWalletAddress[]>([]);
  const [importValue, setImportValue] = useState("");
  const [message, setMessage] = useState<string>();
  const [busyAction, setBusyAction] = useState<"prepare" | "issue" | "registry" | "verify" | "import">();
  const [reviewIssuance, setReviewIssuance] = useState(false);
  const form = useForm<SetupForm>({ resolver: zodResolver(setupSchema), defaultValues: { name: "", ticker: "", precision: 8, supply: "", supplyMode: "fixed", network: "liquid-testnet" } });
  const pendingBootstrap = useQuery({
    queryKey: ["bootstrap-pending", activeDeployment.data?.deploymentId],
    enabled: activeDeployment.data?.publication === "pending",
    queryFn: () => getDraft<BootstrapState | null>(activeDeployment.data!.deploymentId, "bootstrap-state"),
  });
  const preparedRecovery = useQuery({
    queryKey: ["bootstrap-recovery", signer.fingerprint],
    enabled: Boolean(signer.connected && signer.fingerprint && activeDeployment.isFetched && !activeDeployment.data),
    queryFn: async () => {
      const raw = await getDraft<unknown>("setup", "recovery");
      if (!raw) return null;
      const saved = bootstrapRecoverySchema.parse(raw);
      const addresses = await Promise.all([
        deriveWalletAddress(0, 0, saved.network),
        deriveWalletAddress(0, 1, saved.network),
      ]);
      if (!addresses.every((address, index) => address.confidentialAddress === saved.fundingAddresses[index])) {
        throw new Error("The saved issuance recovery belongs to another signer.");
      }
      const { deploymentSalt, fundingAddresses: _fundingAddresses, protocol: _protocol, ...configuration } = saved;
      return { configuration, deploymentSalt, addresses };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const fundingWallet = useBaseWalletSync({
    fingerprint: signer.connected ? signer.fingerprint : undefined,
    network: configuration?.network,
    enabled: Boolean(configuration),
  });
  const fundingSnapshot = fundingWallet.data?.snapshot;
  const confirmedFunding = configuration && fundingSnapshot ? selectSpendableUtxos(fundingSnapshot, configuration.policyAsset, "wallet") : [];
  const fundingPlan = issuanceFundingPlan({
    snapshot: fundingSnapshot,
    assetId: configuration?.policyAsset ?? nativeFeeAssetId("liquid-testnet"),
  });
  const confirmedFundingBalance = fundingPlan.confirmedBalance;
  const pendingFunding = fundingPlan.pendingOutputs;
  const fundingReady = fundingPlan.ready;
  const faucetOutputCount = fundingPlan.faucetOutputs;
  const unusedFundingAddresses = fundingSnapshot?.addresses.filter((address) => address.source === "wallet" && address.branch === 0 && !address.hasActivity).slice(0, faucetOutputCount) ?? fundingAddresses.slice(0, faucetOutputCount);
  const fundingSyncError = fundingWallet.data?.syncError ?? (fundingWallet.error instanceof Error ? fundingWallet.error.message : undefined);
  const fundingPending = !fundingReady && fundingPlan.projectedReady;
  const showFundingActions = Boolean(fundingSnapshot && !fundingSyncError && !fundingWallet.isFetching && faucetOutputCount > 0);

  useEffect(() => {
    if (!pendingBootstrap.data || bootstrapped) return;
    setBootstrapped(pendingBootstrap.data);
    setMode("create");
    setMessage("Restored the pending Liquid testnet issuance. Check confirmation, then prepare its registry files.");
  }, [bootstrapped, pendingBootstrap.data]);

  useEffect(() => {
    if (!preparedRecovery.data || configuration || bootstrapped) return;
    setConfiguration(preparedRecovery.data.configuration);
    setSalt(preparedRecovery.data.deploymentSalt);
    setFundingAddresses(preparedRecovery.data.addresses);
    form.reset(preparedRecovery.data.configuration);
    setMode("create");
    setMessage("Restored the prepared issuance for this signer. Refresh funding, review, and broadcast when ready.");
  }, [bootstrapped, configuration, form, preparedRecovery.data]);

  useEffect(() => {
    if (bootstrapped && message === "Restored the prepared issuance for this signer. Refresh funding, review, and broadcast when ready.") {
      setMessage("Restored the pending Liquid testnet issuance. Check confirmation, then finish canonical registry publication.");
    }
  }, [bootstrapped, message]);

  useEffect(() => {
    if (!bootstrapped || bootstrapped.deployment.confirmations < 1 || registryFiles) return;
    let cancelled = false;
    void Promise.all([
      deploymentRegistryPath(bootstrapped.deployment.deploymentId),
      registryPathForVerifierScript(
        bootstrapped.deployment.deploymentId,
        bootstrapped.snapshot.verifierScriptPubkey,
      ),
    ]).then(([manifestPath, snapshotPath]) => {
      if (!cancelled) setRegistryFiles({ manifestPath, snapshotPath });
    });
    return () => {
      cancelled = true;
    };
  }, [bootstrapped, registryFiles]);

  useEffect(() => {
    if (preparedRecovery.error) setMessage(userFacingError(preparedRecovery.error));
  }, [preparedRecovery.error]);

  async function preview(value: SetupForm) {
    setBusyAction("prepare");
    setMessage("Preparing deterministic issuance and funding addresses…");
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const deploymentSalt = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const policyAsset = nativeFeeAssetId(value.network);
      const addresses = await Promise.all([
        deriveWalletAddress(0, 0, value.network),
        deriveWalletAddress(0, 1, value.network),
      ]);
      const prepared = { ...value, policyAsset };
      setConfiguration(prepared);
      setSalt(deploymentSalt);
      setFundingAddresses(addresses);
      setReviewIssuance(false);
      await putDraft("setup", "recovery", {
        protocol: "simplicity-amp/v0.1",
        deploymentSalt,
        ...prepared,
        fundingAddresses: addresses.map(({ confidentialAddress }) => confidentialAddress),
      });
      setMessage("Asset issuance prepared. Confirmed signer funding will be reused automatically; request only the missing outputs shown below.");
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  function downloadRecovery() {
    if (!configuration || !salt) return;
    const content = canonicalRegistryContent({ schema: "simplicity-amp-recovery-v1", protocol: "simplicity-amp/v0.1", deploymentSalt: salt, ...configuration });
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `simplicity-amp-${configuration.ticker.toLowerCase()}-recovery.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function bootstrap() {
    setBusyAction("issue");
    setMessage("Refreshing wallet funding and validating issuance inputs…");
    try {
      if (!configuration || !salt) throw new Error("Prepare and save recovery data first.");
      const signerState = signerSnapshot();
      if (!signerState.connected || !signerState.fingerprint) throw new Error("Connect the AMP signer first.");
      const wallet = await synchronizeBaseWallet({ fingerprint: signerState.fingerprint, network: configuration.network });
      const policyUtxos = selectSpendableUtxos(wallet, configuration.policyAsset, "wallet");
      const pending = wallet.utxos.filter((utxo) => utxo.source === "wallet" && utxo.assetId === configuration.policyAsset && utxo.status === "unconfirmed").length;
      if (policyUtxos.length < 2) {
        throw new Error(`Asset issuance needs two distinct confirmed L-BTC outputs; found ${policyUtxos.length} confirmed and ${pending} pending.`);
      }
      const result = await bootstrapDeployment({
        network: configuration.network,
        policyAsset: configuration.policyAsset,
        deploymentSalt: salt,
        asset: { name: configuration.name, ticker: configuration.ticker, precision: configuration.precision },
        issuedSupply: configuration.supply,
        supplyMode: configuration.supplyMode,
        policyUtxos,
        fee: "2000",
        requiredConfirmations: 1,
        receiveAlias: configuration.ticker.toLowerCase(),
      });
      // Validate every signer-returned public artifact before the irreversible
      // broadcast. If local validation fails, the prepared transaction never
      // leaves the browser and the two funding outputs remain untouched.
      const manifest = deploymentManifestSchema.parse(result.deployment);
      const deploymentId = await validateDeployment(manifest);
      if (deploymentId !== result.deploymentId) throw new Error("Signer returned a mismatched deployment ID.");
      const snapshot = policySnapshotSchema.parse(result.initialPolicy);
      await validatePolicySnapshot(snapshot);
      if (snapshot.treeDepth !== 4 || snapshot.entryCount !== 0) throw new Error("Bootstrap must use an empty depth-4 blacklist.");
      const initialReceiveRecord = receiveRecordSchema.parse(result.initialReceiveRecord);
      await validateReceiveRecordShape(initialReceiveRecord);
      await validateReceiveRecord(manifest, initialReceiveRecord);
      const local = localDeploymentSchema.parse({ ...manifest, deploymentId, confirmations: 0, activeAnchor: manifest.genesisAnchor, issuerDerivationIndex: result.issuerDerivationIndex, publication: "pending" });
      setMessage("Artifacts validated. Broadcasting the reviewed Liquid testnet issuance…");
      const broadcastTxid = await broadcastTransaction(configuration, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different bootstrap transaction ID.");
      await queryClient.invalidateQueries({ queryKey: walletSyncQueryKeys.wallet(signerState.fingerprint, configuration.network) });
      await putDeployment(local);
      await setActiveDeploymentId(deploymentId);
      await putPolicySnapshot(snapshot, await sha256Hex(snapshot.verifierScriptPubkey));
      await putReceiveRecord(initialReceiveRecord, result.holderDerivationIndex);
      await putDraft(deploymentId, "bootstrap-state", { deployment: local, snapshot } satisfies BootstrapState);
      setBootstrapped({ deployment: local, snapshot });
      setRegistryFiles(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.activeId }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }),
      ]);
      setMessage(`Asset ${manifest.regulatedAsset} issued in ${result.txid}. Confirm it before publishing.`);
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function prepareBootstrapRegistry() {
    setBusyAction("registry");
    setMessage("Checking bootstrap confirmation and preparing canonical registry paths…");
    try {
      if (!bootstrapped) throw new Error("Bootstrap a deployment first.");
      const anchor = await traverseLiveAnchor(bootstrapped.deployment, esploraUrlForDeployment(bootstrapped.deployment));
      if (anchor.live.confirmations < 1) throw new Error("Bootstrap is not confirmed yet.");
      const confirmedDeployment = localDeploymentSchema.parse({
        ...bootstrapped.deployment,
        activeAnchor: `${anchor.live.txid}:0`,
        confirmations: anchor.live.confirmations,
      });
      const confirmedBootstrap = { ...bootstrapped, deployment: confirmedDeployment };
      const snapshotPath = await registryPathForVerifierScript(bootstrapped.deployment.deploymentId, bootstrapped.snapshot.verifierScriptPubkey);
      const manifestPath = deploymentRegistryPath(bootstrapped.deployment.deploymentId);
      await putDeployment(confirmedDeployment);
      await putDraft(confirmedDeployment.deploymentId, "bootstrap-state", confirmedBootstrap);
      setBootstrapped(confirmedBootstrap);
      setRegistryFiles({ manifestPath, snapshotPath });
      await queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active });
      setMessage("Bootstrap confirmed. Download both files, add them at the exact paths shown, and merge them into the default branch.");
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  function downloadBootstrapManifest() {
    if (!bootstrapped || !registryFiles) return;
    downloadCanonicalRegistryFile(registryFiles.manifestPath, publicManifest(bootstrapped.deployment));
  }

  function downloadBootstrapSnapshot() {
    if (!bootstrapped || !registryFiles) return;
    downloadCanonicalRegistryFile(registryFiles.snapshotPath, bootstrapped.snapshot);
  }

  async function copyBootstrapRegistryFile(kind: "manifest" | "snapshot") {
    if (!bootstrapped || !registryFiles) return;
    const [path, content] = kind === "manifest"
      ? [registryFiles.manifestPath, publicManifest(bootstrapped.deployment)]
      : [registryFiles.snapshotPath, bootstrapped.snapshot];
    try {
      await copyCanonicalRegistryFile(path, content);
      setMessage(`Copied the canonical ${kind} bytes for ${path}.`);
    } catch (error) {
      setMessage(userFacingError(error));
    }
  }

  async function verifyBootstrapRegistry() {
    setBusyAction("verify");
    setMessage("Verifying the merged manifest, policy snapshot, and live anchor…");
    try {
      if (!bootstrapped || !registryFiles) throw new Error("Prepare the manual registry files first.");
      const manifest = publicManifest(bootstrapped.deployment);
      const [anchor] = await Promise.all([
        traverseLiveAnchor(bootstrapped.deployment, esploraUrlForDeployment(bootstrapped.deployment)),
        verifyCanonicalRegistryFile(registryFiles.manifestPath, manifest),
        verifyCanonicalRegistryFile(registryFiles.snapshotPath, bootstrapped.snapshot),
      ]);
      if (anchor.live.confirmations < 1) throw new Error("Bootstrap is not confirmed yet.");
      const published = localDeploymentSchema.parse({
        ...bootstrapped.deployment,
        activeAnchor: `${anchor.live.txid}:0`,
        confirmations: anchor.live.confirmations,
        publication: "published",
      });
      await putDeployment(published);
      await putDraft(published.deploymentId, "bootstrap-state", null);
      setBootstrapped({ ...bootstrapped, deployment: published });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }),
      ]);
      setMessage("The merged manifest and D4 snapshot match exactly. This deployment is ready for transfers and policy updates.");
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function importDeployment() {
    setBusyAction("import");
    setMessage("Validating the manifest, canonical policy, chain anchor, and issuer key…");
    try {
      const raw = importValue.trim().startsWith("{") ? JSON.parse(importValue) : await fetch(importValue, { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error(`Registry request failed (${response.status}).`); return response.json(); });
      const manifest = deploymentManifestSchema.parse(raw);
      const deploymentId = await validateDeployment(manifest);
      const temporary = localDeploymentSchema.parse({ ...manifest, deploymentId, confirmations: 0, publication: "published" });
      const anchor = await traverseLiveAnchor(temporary, esploraUrlForDeployment(temporary));
      if (anchor.live.confirmations < 1) throw new Error("Live anchor must be confirmed before import.");
      const snapshot = await resolvePolicySnapshot(temporary, anchor.live.scriptPubkey);
      const issuer = await deriveAmpKey(manifest.deploymentSalt, "issuer");
      if (issuer.publicKey !== manifest.issuerPublicKey) {
        throw new Error("Connected signer does not control this deployment's issuer key.");
      }
      const local = localDeploymentSchema.parse({ ...temporary, confirmations: anchor.live.confirmations, activeAnchor: `${anchor.live.txid}:0`, issuerDerivationIndex: issuer.derivationIndex });
      await putDeployment(local);
      await setActiveDeploymentId(deploymentId);
      await putPolicySnapshot(snapshot, await sha256Hex(snapshot.verifierScriptPubkey));
      await Promise.all([queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }), queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active })]);
      setMessage(`Imported ${shortHash(deploymentId)} at ${shortHash(anchor.live.txid)}.`);
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <AppShell eyebrow="Issuer console / Setup" title="Create or import a deployment">
      <BackLink to="/admin">Back to policy workspace</BackLink>
      {mode === "choose" && <div className="setup-choice-grid"><button className="choice-card" type="button" onClick={() => setMode("create")}><span><Rocket size={22} /></span><div><small>New deployment</small><h2>Create</h2><p>Issue the regulated asset, optional token, and one verifier unit with the local AMP Signer SDK.</p></div><ArrowRight size={19} /></button><button className="choice-card" type="button" onClick={() => setMode("import")}><span><Upload size={22} /></span><div><small>Existing deployment</small><h2>Import</h2><p>Validate the manifest, canonical live policy, chain anchor, and issuer key.</p></div><ArrowRight size={19} /></button></div>}
      {mode === "create" && (
        <div className="setup-layout">
          <Panel className="setup-main">
            <form className="form-stack" onSubmit={form.handleSubmit(preview)}>
              <SectionHeading label="Bootstrap configuration" title="Issue an asset" />
              <div className="form-grid-two">
                <label>Asset name<input {...form.register("name")} /></label>
                <label>Ticker<input {...form.register("ticker")} /></label>
                <label>Precision<input type="number" {...form.register("precision", { valueAsNumber: true })} /></label>
                <label>Initial supply<input inputMode="numeric" {...form.register("supply")} /></label>
              </div>
              <label>Network<select {...form.register("network")}><option value="liquid-testnet">Liquid testnet</option><option value="elements-regtest">Elements regtest</option></select></label>
              <fieldset>
                <legend>Supply model</legend>
                <label className="radio-card"><input type="radio" value="fixed" {...form.register("supplyMode")} /><span><strong>Fixed</strong><small>Destroy the regulated-asset reissuance token.</small></span></label>
                <label className="radio-card"><input type="radio" value="issuer-managed" {...form.register("supplyMode")} /><span><strong>Issuer managed</strong><small>The signer wallet retains the confidential reissuance token.</small></span></label>
              </fieldset>
              <button className="button issuer-primary wide" disabled={Boolean(busyAction) || Boolean(bootstrapped)} type="submit">{bootstrapped ? "Asset issuance complete" : busyAction === "prepare" ? "Preparing…" : "Prepare asset issuance"}</button>
            </form>
            {configuration && salt && (
              <div className="setup-step">
                <pre>{canonicalRegistryContent({ deploymentSalt: salt, ...configuration, fundingAddresses: fundingAddresses.map(({ confidentialAddress }) => confidentialAddress) })}</pre>
                <p>The signer will derive the new regulated-asset ID from the issuance transaction. L-BTC is selected automatically as the network fee asset.</p>
                <div className="funding-status">
                  <span><Fuel size={15} /> {fundingReady ? `Ready: ${confirmedFunding.length} confirmed outputs provide ${formatUnits(confirmedFundingBalance, 8)} L-BTC.` : fundingPending ? `${pendingFunding} funding output${pendingFunding === 1 ? " is" : "s are"} awaiting confirmation.` : fundingSyncError ? "Wallet sync failed; faucet actions are paused." : fundingWallet.isFetching ? "Scanning all derived wallet addresses…" : signer.connected ? `${confirmedFunding.length} of 2 confirmed outputs · ${formatUnits(confirmedFundingBalance, 8)} L-BTC available.` : "Connect the signer to restore its funding state."}</span>
                  <button className="icon-button" disabled={!signer.connected || fundingWallet.isFetching} type="button" aria-label="Refresh issuance funding" onClick={() => void fundingWallet.refetch()}><RefreshCw size={15} /></button>
                </div>
                {showFundingActions && <div className="funding-list">
                  {unusedFundingAddresses.map((address, index) => (
                    <div key={address.confidentialAddress}>
                      <span><Fuel size={15} /> Needed funding output {index + 1}</span>
                      <code>{address.confidentialAddress}</code>
                      {configuration.network === "liquid-testnet" ? <a className="button secondary" href={liquidTestnetFaucetUrl(address.confidentialAddress)} target="_blank" rel="noreferrer">Request testnet L-BTC <ExternalLink size={14} /></a> : <small>Fund this address from the local Elements node.</small>}
                    </div>
                  ))}
                </div>}
                {fundingSyncError && <p className="field-error">{fundingSyncError}</p>}
                <div className="review-buttons">
                  <button className="button secondary" disabled={Boolean(busyAction)} type="button" onClick={downloadRecovery}><Download size={16} /> Save recovery</button>
                  <button className="button issuer-primary" disabled={Boolean(busyAction) || Boolean(bootstrapped) || !signer.connected || !fundingReady} type="button" onClick={() => { setReviewIssuance(true); setMessage("Review the Liquid testnet issuance, fee, and destinations before signing."); }}>Review issuance <ArrowRight size={16} /></button>
                </div>
                {reviewIssuance && <div className="review-stack issuance-review" aria-label="Issuance review">
                  <div className="review-row"><span>Network</span><strong>{configuration.network === "liquid-testnet" ? "Liquid testnet" : "Elements regtest"}</strong></div>
                  <div className="review-row"><span>Funding</span><strong>{fundingPlan.confirmedOutputs} confirmed outputs · {formatUnits(fundingPlan.confirmedBalance, 8)} L-BTC</strong></div>
                  <div className="review-row"><span>Network fee</span><strong>0.00002 L-BTC</strong></div>
                  <div className="review-row"><span>Issued supply</span><strong>{configuration.supply} {configuration.ticker} base units</strong></div>
                  <div className="review-row"><span>Destinations</span><strong>Signer holder covenant{configuration.supplyMode === "issuer-managed" ? " + signer reissuance token" : ""}</strong></div>
                  <div className="review-buttons"><button className="button secondary" disabled={Boolean(busyAction)} type="button" onClick={() => setReviewIssuance(false)}>Back</button><button className="button issuer-primary" disabled={Boolean(busyAction) || Boolean(bootstrapped) || !fundingReady} type="button" onClick={bootstrap}>{bootstrapped ? "Already broadcast" : busyAction === "issue" ? "Validating and signing…" : "Sign and broadcast"}</button></div>
                </div>}
              </div>
            )}
            {bootstrapped && <div className="review-stack bootstrap-result" aria-label="Bootstrap result">
              <div className="review-row"><span>Issuance transaction</span><strong><code title={bootstrapped.deployment.genesisAnchor.split(":")[0]}>{shortHash(bootstrapped.deployment.genesisAnchor.split(":")[0], 12, 10)}</code></strong></div>
              <div className="review-row"><span>Chain state</span><strong>{bootstrapped.deployment.confirmations > 0 ? `${bootstrapped.deployment.confirmations} confirmation${bootstrapped.deployment.confirmations === 1 ? "" : "s"}` : "Awaiting confirmation"}</strong></div>
              <div className="review-row"><span>Registry state</span><strong>{bootstrapped.deployment.publication === "published" ? "Published" : registryFiles ? "Ready for manual publication" : "Pending confirmation check"}</strong></div>
              {bootstrapped.deployment.network === "liquid-testnet" && <a className="button secondary" href={`https://blockstream.info/liquidtestnet/tx/${bootstrapped.deployment.genesisAnchor.split(":")[0]}`} target="_blank" rel="noreferrer">View transaction <ExternalLink size={14} /></a>}
            </div>}
            {bootstrapped && !registryFiles && <button className="button issuer-primary wide" disabled={Boolean(busyAction)} type="button" onClick={prepareBootstrapRegistry}><Download size={16} /> {busyAction === "registry" ? "Checking confirmation…" : "Prepare confirmed registry files"}</button>}
            {bootstrapped && registryFiles && (
              <div className="registry-files">
                <div><span>Deployment manifest</span><code title={registryFiles.manifestPath}>{registryFiles.manifestPath}</code><div className="registry-file-actions"><button className="button secondary" type="button" onClick={() => void copyBootstrapRegistryFile("manifest")}><ClipboardCopy size={15} /> Copy</button><button className="button secondary" type="button" onClick={downloadBootstrapManifest}><Download size={15} /> Download</button></div></div>
                <div><span>Initial D4 policy</span><code title={registryFiles.snapshotPath}>{registryFiles.snapshotPath}</code><div className="registry-file-actions"><button className="button secondary" type="button" onClick={() => void copyBootstrapRegistryFile("snapshot")}><ClipboardCopy size={15} /> Copy</button><button className="button secondary" type="button" onClick={downloadBootstrapSnapshot}><Download size={15} /> Download</button></div></div>
                <div className="registry-actions"><a className="button secondary" href={registryRepositoryUrl} target="_blank" rel="noreferrer"><GitPullRequest size={15} /> Open repository</a><button className="button issuer-primary" disabled={Boolean(busyAction)} type="button" onClick={verifyBootstrapRegistry}><ShieldCheck size={15} /> {busyAction === "verify" ? "Verifying…" : "Verify merged files"}</button></div>
              </div>
            )}
            {message && <p className="inline-message" role="status">{message}</p>}
          </Panel>
          <aside className="setup-aside"><SafetyNote title="Small first tree">Every deployment starts with the D4 verifier. Governance upgrades to D5 or D6 only when the blacklist grows.</SafetyNote></aside>
        </div>
      )}
      {mode === "import" && <div className="setup-layout"><Panel className="setup-main"><SectionHeading label="Import deployment" title="Manifest JSON or URL" /><div className="form-stack"><label>Public source<textarea rows={12} value={importValue} onChange={(event) => setImportValue(event.target.value)} /></label><button className="button issuer-primary wide" disabled={Boolean(busyAction) || !importValue.trim()} type="button" onClick={importDeployment}><ShieldCheck size={16} /> {busyAction === "import" ? "Validating…" : "Validate and prove issuer control"}</button></div>{message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}</Panel></div>}
    </AppShell>
  );
}

const reissueSchema = z.object({ amount: z.string().regex(/^[1-9][0-9]*$/), reason: z.string().trim().min(3).max(280) });
type ReissueForm = z.infer<typeof reissueSchema>;

export function AdminReissue() {
  const deployment = useActiveDeployment();
  const { anchor, policy } = useLivePolicy(deployment.data);
  const queryClient = useQueryClient();
  const [review, setReview] = useState<ReissueForm>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = useForm<ReissueForm>({ resolver: zodResolver(reissueSchema) });

  async function authorize() {
    setBusy(true);
    setMessage("Refreshing the live anchor, wallet funds, and reissuance token…");
    try {
      const selected = requirePublishedDeployment(deployment.data);
      if (selected.supplyMode !== "issuer-managed") throw new Error("This deployment has fixed supply.");
      if (!anchor.data || !policy.data) throw new Error("Resolve the live anchor and policy first.");
      if (!review) throw new Error("Review the reissuance first.");
      const esplora = esploraUrlForDeployment(selected);
      await requireFreshAnchor(selected, anchor.data.live, esplora);
      if (selected.issuerDerivationIndex === undefined) {
        throw new Error("This deployment has no local issuer-key locator.");
      }
      const signer = signerSnapshot();
      if (!signer.connected || !signer.fingerprint) throw new Error("Connect the AMP signer first.");
      const [wallet, verifierUtxo, recipient] = await Promise.all([
        synchronizeDeploymentWallet(selected, signer.fingerprint),
        liveAnchorUtxo(selected, anchor.data.live.txid),
        ensureSignerReceiveRecord(selected, signer.fingerprint),
      ]);
      const fees = selectSpendableUtxos(wallet, selected.policyAsset, "wallet");
      const tokenUtxo = selectSpendableUtxos(wallet, selected.reissuanceToken!, "wallet")[0];
      if (!tokenUtxo) throw new Error("The signer wallet has no confirmed reissuance token.");
      await requireFreshAnchor(selected, anchor.data.live, esplora);
      const result = await reissue({
        deployment: publicManifest(selected),
        currentPolicy: policy.data,
        verifierUtxo,
        tokenUtxo,
        feeUtxos: fees,
        recipient: recipient.record,
        amount: review.amount,
        fee: "2000",
        issuerDerivationIndex: selected.issuerDerivationIndex,
      });
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      await queryClient.invalidateQueries({ queryKey: walletSyncQueryKeys.wallet(signer.fingerprint, selected.network) });
      setMessage(`Reissuance broadcast: ${result.txid}`);
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell eyebrow="Issuer console / Reissue" title="Mint governed supply">
      <BackLink to="/admin">Back to policy workspace</BackLink>
      <div className="setup-layout"><Panel className="setup-main"><SectionHeading label="Managed supply" title={review ? "Review the mint" : "Define the reissuance"} aside={<Pill tone="warn">Issuer governed</Pill>} />{!deployment.data ? <p>No deployment is selected. Create or import one in Setup before reissuing.</p> : deployment.data.publication !== "published" ? <div className="generate-record"><ShieldCheck size={26} /><p>The deployment is confirmed, but reissuance remains locked until canonical registry publication is verified.</p><Link className="button issuer-primary" to="/admin/setup">Finish registry publication</Link></div> : deployment.data.supplyMode !== "issuer-managed" ? <p>This deployment is fixed-supply; reissuance is disabled.</p> : !review ? <form className="form-stack" onSubmit={form.handleSubmit(setReview)}><label>New base units<input inputMode="numeric" {...form.register("amount")} /></label><label>Public reason<textarea rows={4} {...form.register("reason")} /></label><button className="button issuer-primary wide" type="submit">Review reissuance <ArrowRight size={16} /></button></form> : <div className="review-stack"><div className="review-row"><span>New units</span><strong>{review.amount}</strong></div><div className="review-row"><span>Verifier</span><strong>Same script, governance spend</strong></div><div className="review-row"><span>Destination</span><strong>Validated holder covenant</strong></div><div className="review-buttons"><button className="button secondary" disabled={busy} type="button" onClick={() => setReview(undefined)}>Edit</button><button className="button issuer-primary" disabled={busy} type="button" onClick={authorize}>{busy ? "Validating and signing…" : "Sign locally"} <ArrowRight size={16} /></button></div></div>}{message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}</Panel><aside className="setup-aside"><div className="risk-note"><AlertTriangle size={18} /><p><strong>Issuer authority</strong>The AMP Signer SDK verifies the current anchor, token, holder destination, recreated script, explicit assets, and exact fee before using issuer secrets.</p></div><Panel><h3>Required checks</h3><ul className="check-list"><li><RefreshCw size={15} /> Fresh winning anchor</li><li><Check size={15} /> Token returned</li><li><Check size={15} /> Same verifier script</li><li><Check size={15} /> Holder-only new supply</li></ul></Panel></aside></div>
    </AppShell>
  );
}
