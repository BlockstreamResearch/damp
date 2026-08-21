import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AlertTriangle, ArrowRight, Check, ClipboardCopy, Download, ExternalLink, Fuel, GitPullRequest, ListFilter, Minus, Plus, RefreshCw, Rocket, ShieldCheck, Upload } from "lucide-react";

import { AppShell, BackLink, Panel, Pill, SafetyNote, SectionHeading, TechnicalDetails } from "../components/ui";
import { BlacklistTable } from "../components/blacklist-table";
import { AdminStatusStrip } from "../components/admin-status-strip";
import { BootstrapRegistryState } from "../components/bootstrap-registry-state";
import { OperationReceiptPanel } from "../components/operation-receipt";
import {
  bootstrap as bootstrapDeployment,
  buildBlacklist,
  deriveWalletAddress,
  reissue,
  signerSessionRevision,
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
import {
  blacklistDraftName,
  blacklistScope,
  isCurrentBlacklistLoad,
  pendingPolicyDraftName,
  requireCurrentBlacklistScope,
} from "../lib/blacklist-drafts";
import {
  attachIssuerControl,
  persistPublicDeploymentImport,
  validatePublicDeploymentImport,
} from "../lib/deployment-import";
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
import { reissueSchema, setupSchema, type ReissueForm, type SetupForm } from "../lib/form-schemas";
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
  const signerState = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const { anchor, policy } = useLivePolicy(deployment.data);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BlacklistEntry[]>([]);
  const [loadedScope, setLoadedScope] = useState<string>();
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [pending, setPending] = useState<PolicySnapshot>();
  const [pendingPath, setPendingPath] = useState<string>();
  const [reviewUpdate, setReviewUpdate] = useState(false);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const loadToken = useRef<symbol | undefined>(undefined);
  const activeScope = useRef<string | undefined>(undefined);
  const form = useForm<EntryForm>({ resolver: zodResolver(entryFormSchema) });

  useEffect(() => {
    const key = `policy-update:${deployment.data?.deploymentId ?? "none"}:${signerState.profileId ?? "locked"}`;
    setSignerOperationPending(key, Boolean(reviewUpdate || busy));
    return () => setSignerOperationPending(key, false);
  }, [busy, deployment.data?.deploymentId, reviewUpdate, signerState.profileId]);

  useEffect(() => {
    const current = policy.data;
    const selected = deployment.data;
    if (!current || !selected) {
      setLoadedScope(undefined);
      activeScope.current = undefined;
      setWorkspaceReady(false);
      setDraft([]);
      setPending(undefined);
      setPendingPath(undefined);
      setReviewUpdate(false);
      return;
    }
    const scope = blacklistScope(selected.deploymentId, current.policyRoot, signerState.profileId);
    const token = Symbol(scope);
    loadToken.current = token;
    activeScope.current = scope;
    setLoadedScope(scope);
    setWorkspaceReady(false);
    setDraft(current.entries);
    setPending(undefined);
    setPendingPath(undefined);
    setReviewUpdate(false);
    setMessage(undefined);
    void Promise.all([
      getDraft<BlacklistEntry[]>(selected.deploymentId, blacklistDraftName(current.policyRoot, signerState.profileId)),
      getDraft<PolicySnapshot>(selected.deploymentId, pendingPolicyDraftName(current.policyRoot, signerState.profileId)),
    ]).then(([stored, storedPending]) => {
      if (!isCurrentBlacklistLoad(loadToken.current, token)) return;
      setDraft(stored ?? current.entries);
      if (storedPending?.parentPolicyRoot === current.policyRoot) {
        setPending(storedPending);
        void registryPathForVerifierScript(selected.deploymentId, storedPending.verifierScriptPubkey).then((path) => {
          if (isCurrentBlacklistLoad(loadToken.current, token)) setPendingPath(path);
        }).catch((error) => {
          if (isCurrentBlacklistLoad(loadToken.current, token)) setMessage(userFacingError(error));
        });
      } else {
        setPending(undefined);
        setPendingPath(undefined);
      }
      setWorkspaceReady(true);
    }).catch((error) => {
      if (!isCurrentBlacklistLoad(loadToken.current, token)) return;
      setWorkspaceReady(false);
      setMessage(`Could not restore this blacklist workspace: ${userFacingError(error)}`);
    });
    return () => {
      if (isCurrentBlacklistLoad(loadToken.current, token)) loadToken.current = undefined;
    };
  }, [deployment.data?.deploymentId, policy.data?.policyRoot, signerState.profileId]);

  useEffect(() => {
    const selected = deployment.data;
    const current = policy.data;
    if (!selected || !current || !workspaceReady) return;
    const scope = blacklistScope(selected.deploymentId, current.policyRoot, signerState.profileId);
    if (loadedScope !== scope) return;
    void putDraft(selected.deploymentId, blacklistDraftName(current.policyRoot, signerState.profileId), draft).catch((error) => {
      if (activeScope.current === scope) setMessage(`Could not save this blacklist draft: ${userFacingError(error)}`);
    });
  }, [deployment.data?.deploymentId, draft, loadedScope, policy.data?.policyRoot, signerState.profileId, workspaceReady]);

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

  const renderedScope = deployment.data && policy.data
    ? blacklistScope(deployment.data.deploymentId, policy.data.policyRoot, signerState.profileId)
    : undefined;
  const scopedDraft = renderedScope && loadedScope === renderedScope
    ? draft
    : policy.data?.entries ?? [];
  const workspaceForCurrentPolicy = Boolean(renderedScope && loadedScope === renderedScope && workspaceReady);
  const scopedPending = workspaceForCurrentPolicy && pending?.parentPolicyRoot === policy.data?.policyRoot
    ? pending
    : undefined;
  const scopedPendingPath = scopedPending ? pendingPath : undefined;
  const depth = smallestTreeDepth(scopedDraft.length);
  const preview = useQuery({
    queryKey: ["policy-preview", deployment.data?.deploymentId, policy.data?.policyRoot, depth, scopedDraft],
    enabled: Boolean(deployment.data),
    queryFn: () => buildBlacklist(scopedDraft, depth),
  });
  const changes = useMemo(() => {
    const key = (entry: BlacklistEntry) => `${entry.txid}:${entry.vout}`;
    const current = new Set((policy.data?.entries ?? []).map(key));
    const next = new Set(scopedDraft.map(key));
    return { added: scopedDraft.filter((entry) => !current.has(key(entry))).length, removed: (policy.data?.entries ?? []).filter((entry) => !next.has(key(entry))).length };
  }, [scopedDraft, policy.data]);
  const activeOutpoints = useMemo(
    () => new Set((policy.data?.entries ?? []).map((entry) => `${entry.txid}:${entry.vout}`)),
    [policy.data?.entries],
  );

  function addEntry(value: EntryForm) {
    const [txid, output] = value.outpoint.split(":");
    const entry = blacklistEntrySchema.parse({ txid, vout: Number(output), note: value.note || undefined });
    if (!workspaceForCurrentPolicy) return;
    if (scopedDraft.some((candidate) => candidate.txid === entry.txid && candidate.vout === entry.vout)) {
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
      const scope = blacklistScope(selected.deploymentId, current.policyRoot, signerState.profileId);
      const successor = await buildSuccessorPolicy(selected, current, scopedDraft);
      const path = await registryPathForVerifierScript(selected.deploymentId, successor.verifierScriptPubkey);
      requireCurrentBlacklistScope(activeScope.current, scope);
      const downloaded = downloadCanonicalRegistryFile(path, successor);
      setPending(successor);
      setPendingPath(path);
      setReviewUpdate(false);
      await putDraft(selected.deploymentId, pendingPolicyDraftName(current.policyRoot, signerState.profileId), successor);
      setMessage(`Downloaded ${downloaded.filename}. Add it at ${path}, merge it into the default branch, then activate.`);
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyPendingPolicySnapshot() {
    if (!scopedPending || !scopedPendingPath) return;
    try {
      await copyCanonicalRegistryFile(scopedPendingPath, scopedPending);
      setMessage(`Copied the exact successor snapshot bytes for ${scopedPendingPath}.`);
    } catch (error) {
      setMessage(userFacingError(error));
    }
  }

  async function activate() {
    let attemptedScope: { deploymentId: string; policyRoot: string; signerProfileId?: string; scope: string } | undefined;
    setBusy(true);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      const current = policy.data;
      const originalAnchor = anchor.data;
      if (!current || !originalAnchor) throw new Error("Resolve the canonical live policy first.");
      const scope = blacklistScope(selected.deploymentId, current.policyRoot, signerState.profileId);
      attemptedScope = { deploymentId: selected.deploymentId, policyRoot: current.policyRoot, signerProfileId: signerState.profileId, scope };
      const successor = scopedPending ?? await getDraft<PolicySnapshot>(selected.deploymentId, pendingPolicyDraftName(current.policyRoot, signerState.profileId));
      if (!successor) throw new Error("Download a successor snapshot first.");
      const path = await registryPathForVerifierScript(selected.deploymentId, successor.verifierScriptPubkey);
      await verifyCanonicalRegistryFile(path, successor);
      requireCurrentBlacklistScope(activeScope.current, scope);
      const esplora = esploraUrlForDeployment(selected);
      await requireFreshAnchor(selected, originalAnchor.live, esplora);
      const signer = signerSnapshot();
      if (!signer.connected || !signer.profileId) throw new Error("Connect the AMP signer first.");
      const [verifierUtxo, wallet] = await Promise.all([
        liveAnchorUtxo(selected, originalAnchor.live.txid),
        synchronizeDeploymentWallet(selected, signer.profileId),
      ]);
      const fees = selectSpendableUtxos(wallet, selected.policyAsset, "wallet");
      await requireFreshAnchor(selected, originalAnchor.live, esplora);
      requireCurrentBlacklistScope(activeScope.current, scope);
      if (selected.issuerDerivationIndex === undefined || selected.issuerProfileId !== signer.profileId) {
        throw new Error("Attach issuer control for the active signer profile before authorizing governance.");
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
      requireCurrentBlacklistScope(activeScope.current, scope);
      if (signerSnapshot().profileId !== signer.profileId) {
        throw new Error("The active signer profile changed before broadcast. Review the policy update again.");
      }
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      setMessage(`Policy update ${result.txid} broadcast. Waiting for the confirmed successor anchor…`);
      const winning = await waitForAnchor(selected, successor.verifierScriptPubkey);
      await putDeployment({ ...selected, activeAnchor: `${winning.live.txid}:0`, confirmations: winning.live.confirmations });
      await putPolicySnapshot(successor, await sha256Hex(successor.verifierScriptPubkey));
      if (activeScope.current === scope) {
        setPending(undefined);
        setPendingPath(undefined);
        setReviewUpdate(false);
        setLoadedScope(undefined);
        setWorkspaceReady(false);
      }
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["anchor", selected.deploymentId] }), queryClient.invalidateQueries({ queryKey: ["policy", selected.deploymentId] }), queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }), queryClient.invalidateQueries({ queryKey: walletSyncQueryKeys.wallet(signer.profileId, selected.network) })]);
      if (activeScope.current === scope) setMessage(`Policy ${successor.sequence} active at ${winning.live.txid}:0.`);
    } catch (error) {
      if (error instanceof AnchorConflictError && attemptedScope) {
        await putDraft(attemptedScope.deploymentId, pendingPolicyDraftName(attemptedScope.policyRoot, attemptedScope.signerProfileId), null);
        if (activeScope.current === attemptedScope.scope) {
          setPending(undefined);
          setPendingPath(undefined);
          setReviewUpdate(false);
        }
      }
      if (!attemptedScope || activeScope.current === attemptedScope.scope) setMessage(userFacingError(error));
    } finally {
      setBusy(false);
    }
  }

  const selected = deployment.data;
  return (
    <AppShell eyebrow="Issuer console" title="Exact-outpoint blacklist">
      {!selected ? <div className="empty-state"><ListFilter size={24} /><h2>No active deployment</h2><p>Create or import one before editing policy.</p></div> : selected.publication !== "published" ? <div className="empty-state"><ShieldCheck size={24} /><h2>Registry publication pending</h2><p>The confirmed deployment is visible, but blacklist governance remains locked until its manifest and D4 snapshot match the canonical default branch.</p><Link className="button issuer-primary" to="/admin/setup">Finish registry publication</Link></div> : <>
        <AdminStatusStrip deploymentName={selected.asset.name} liveAnchorTxid={anchor.data?.live.txid} treeDepth={policy.data?.treeDepth} confirmations={anchor.data?.live.confirmations ?? 0} />
        <div className="admin-grid">
          <Panel className="policy-editor"><SectionHeading label="Policy entries" title={`${scopedDraft.length} exact outpoint${scopedDraft.length === 1 ? "" : "s"}`} aside={<Pill tone={changes.added || changes.removed ? "warn" : "neutral"}>{changes.added + changes.removed} changes</Pill>} />
            <form className="inline-add-form" onSubmit={form.handleSubmit(addEntry)}><label>Exact outpoint<input aria-invalid={Boolean(form.formState.errors.outpoint)} aria-describedby={form.formState.errors.outpoint ? "blacklist-outpoint-error" : undefined} placeholder="txid:vout" spellCheck={false} {...form.register("outpoint")} /></label><label>Internal note <span>(not consensus)</span><input aria-invalid={Boolean(form.formState.errors.note)} aria-describedby={form.formState.errors.note ? "blacklist-note-error" : undefined} {...form.register("note")} /></label><button className="button issuer-primary" disabled={busy || !workspaceForCurrentPolicy} type="submit"><Plus size={16} /> Add</button>{form.formState.errors.outpoint && <small id="blacklist-outpoint-error" className="field-error form-wide">{form.formState.errors.outpoint.message}</small>}{form.formState.errors.note && <small id="blacklist-note-error" className="field-error form-wide">{form.formState.errors.note.message}</small>}</form>
            <BlacklistTable entries={scopedDraft} activeOutpoints={activeOutpoints} disabled={busy || !workspaceForCurrentPolicy} onRemove={(entry) => setDraft((entries) => entries.filter((candidate) => candidate !== entry))} />
          </Panel>
          <aside className="policy-sidebar"><Panel><SectionHeading label="Iterative capacity" title={`Depth ${depth} · ${2 ** depth} entries`} /><div className="diff-counts"><div><Plus size={15} /><span><strong>{changes.added}</strong> added</span></div><div><Minus size={15} /><span><strong>{changes.removed}</strong> removed</span></div></div><div className="root-preview"><small>Next policy digest</small><code>{preview.data ? shortHash(preview.data.policyRoot, 12, 10) : "Calculating…"}</code></div><button className="button secondary wide" disabled={!workspaceForCurrentPolicy} type="button" onClick={() => setDraft(policy.data?.entries ?? [])}>Discard draft</button></Panel><SafetyNote title="Two-phase activation">The exact immutable snapshot must be retrievable from the canonical default branch before the local signer authorizes governance.</SafetyNote></aside>
        </div>
        <Panel className="publish-flow">
          <SectionHeading label="Manual publication" title="Move this draft on chain" />
          <div className="publish-steps">
            <div><span>1</span><div><strong>Download snapshot</strong><small>D{depth}, exact canonical bytes</small></div><button className="button secondary" disabled={busy || !(changes.added || changes.removed)} type="button" onClick={downloadPolicySnapshot}><Download size={15} /> Download JSON</button></div>
            <div><span>2</span><div><strong>Add and merge the file</strong><small title={scopedPendingPath}>{scopedPendingPath ?? "Download to calculate its exact path"}</small></div><div className="publish-step-actions"><button className="button secondary" disabled={!scopedPending} type="button" onClick={() => void copyPendingPolicySnapshot()}><ClipboardCopy size={15} /> Copy JSON</button><a className="button secondary" href={registryRepositoryUrl} target="_blank" rel="noreferrer"><GitPullRequest size={15} /> Open repository</a></div></div>
            <div><span>3</span><div><strong>Verify and activate</strong><small>Checks exact merged bytes and the live anchor</small></div><button className="button issuer-primary" disabled={busy || !scopedPending} type="button" onClick={() => setReviewUpdate(true)}>Review update <ArrowRight size={15} /></button></div>
          </div>
          {reviewUpdate && scopedPending && <div className="review-stack" aria-label="Policy update review">
            <div className="review-row"><span>Policy sequence</span><strong>{policy.data?.sequence ?? "–"} → {scopedPending.sequence}</strong></div>
            <div className="review-row"><span>Blacklist</span><strong>{scopedPending.entryCount} exact outpoint{scopedPending.entryCount === 1 ? "" : "s"} · D{scopedPending.treeDepth}</strong></div>
            <div className="review-row"><span>Current anchor</span><strong>{anchor.data ? `${shortHash(anchor.data.live.txid)}:0` : "Resolving…"}</strong></div>
            <div className="review-row"><span>Network fee</span><strong>0.000015 L-BTC</strong></div>
            <div className="review-buttons"><button className="button secondary" disabled={busy} type="button" onClick={() => setReviewUpdate(false)}>Back</button><button className="button issuer-primary" disabled={busy || !signerState.walletReady} type="button" onClick={() => void activate()}>{busy ? "Validating and signing…" : !signerState.walletReady ? "Sync wallet before signing" : "Sign and activate"} <ArrowRight size={15} /></button></div>
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
  const [importedDeployment, setImportedDeployment] = useState<Deployment>();
  const [importError, setImportError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busyAction, setBusyAction] = useState<"prepare" | "issue" | "confirm" | "registry" | "verify" | "import" | "attach">();
  const [reviewIssuance, setReviewIssuance] = useState(false);
  const previousSetupSigner = useRef(signer.profileId);
  const importFieldRef = useRef<HTMLTextAreaElement>(null);
  const form = useForm<SetupForm>({ resolver: zodResolver(setupSchema), defaultValues: { name: "", ticker: "", precision: 8, supply: "", supplyMode: "fixed", network: "liquid-testnet" } });
  const pendingBootstrap = useQuery({
    queryKey: ["bootstrap-pending", activeDeployment.data?.deploymentId],
    enabled: activeDeployment.data?.publication === "pending",
    queryFn: () => getDraft<BootstrapState | null>(activeDeployment.data!.deploymentId, "bootstrap-state"),
  });
  const preparedRecovery = useQuery({
    queryKey: ["bootstrap-recovery", signer.profileId],
    enabled: Boolean(signer.connected && signer.profileId && activeDeployment.isFetched && !activeDeployment.data),
    queryFn: async () => {
      const raw = await getDraft<unknown>("setup", `recovery:${signer.profileId}`);
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
    profileId: signer.connected ? signer.profileId : undefined,
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
    if (previousSetupSigner.current === signer.profileId) return;
    previousSetupSigner.current = signer.profileId;
    setConfiguration(undefined);
    setSalt(undefined);
    setFundingAddresses([]);
    setReviewIssuance(false);
    setMessage(undefined);
    form.reset({ name: "", ticker: "", precision: 8, supply: "", supplyMode: "fixed", network: signer.network ?? "liquid-testnet" });
  }, [form, signer.network, signer.profileId]);

  useEffect(() => {
    const key = `bootstrap:${activeDeployment.data?.deploymentId ?? "new"}:${signer.profileId ?? "locked"}`;
    setSignerOperationPending(key, Boolean(reviewIssuance || busyAction));
    return () => setSignerOperationPending(key, false);
  }, [activeDeployment.data?.deploymentId, busyAction, reviewIssuance, signer.profileId]);

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
    if (preparedRecovery.error) setMessage(userFacingError(preparedRecovery.error));
  }, [preparedRecovery.error]);

  async function preview(value: SetupForm) {
    setBusyAction("prepare");
    setMessage("Preparing deterministic issuance and funding addresses…");
    try {
      const activeSigner = signerSnapshot();
      if (!activeSigner.connected || !activeSigner.fingerprint || !activeSigner.profileId) throw new Error("Connect the AMP signer first.");
      const signerRevision = signerSessionRevision();
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const deploymentSalt = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const policyAsset = nativeFeeAssetId(value.network);
      const addresses = await Promise.all([
        deriveWalletAddress(0, 0, value.network),
        deriveWalletAddress(0, 1, value.network),
      ]);
      if (signerSessionRevision() !== signerRevision || signerSnapshot().profileId !== activeSigner.profileId) {
        throw new Error("The active signer profile changed while preparing issuance. Start again.");
      }
      const prepared = { ...value, policyAsset };
      setConfiguration(prepared);
      setSalt(deploymentSalt);
      setFundingAddresses(addresses);
      setReviewIssuance(false);
      await putDraft("setup", `recovery:${activeSigner.profileId}`, {
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
      if (!signerState.connected || !signerState.fingerprint || !signerState.profileId) throw new Error("Connect the AMP signer first.");
      const wallet = await synchronizeBaseWallet({ profileId: signerState.profileId, network: configuration.network });
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
      const local = localDeploymentSchema.parse({ ...manifest, deploymentId, confirmations: 0, activeAnchor: manifest.genesisAnchor, issuerDerivationIndex: result.issuerDerivationIndex, issuerFingerprint: signerState.fingerprint, issuerProfileId: signerState.profileId, publication: "pending" });
      if (signerSnapshot().profileId !== signerState.profileId) {
        throw new Error("The active signer profile changed before broadcast. Review the issuance again.");
      }
      setMessage("Artifacts validated. Broadcasting the reviewed Liquid testnet issuance…");
      const broadcastTxid = await broadcastTransaction(configuration, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different bootstrap transaction ID.");
      await queryClient.invalidateQueries({ queryKey: walletSyncQueryKeys.wallet(signerState.profileId, configuration.network) });
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

  async function checkBootstrapConfirmation() {
    setBusyAction("confirm");
    setMessage("Checking the issuance transaction for a Liquid block confirmation…");
    try {
      if (!bootstrapped) throw new Error("Bootstrap a deployment first.");
      const anchor = await traverseLiveAnchor(bootstrapped.deployment, esploraUrlForDeployment(bootstrapped.deployment));
      if (anchor.live.confirmations < 1) {
        setMessage("The issuance transaction is still unconfirmed. Wait for a Liquid block, then check again.");
        return;
      }
      const confirmedDeployment = localDeploymentSchema.parse({
        ...bootstrapped.deployment,
        activeAnchor: `${anchor.live.txid}:0`,
        confirmations: anchor.live.confirmations,
      });
      const confirmedBootstrap = { ...bootstrapped, deployment: confirmedDeployment };
      await putDeployment(confirmedDeployment);
      await putDraft(confirmedDeployment.deploymentId, "bootstrap-state", confirmedBootstrap);
      setBootstrapped(confirmedBootstrap);
      await queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active });
      setMessage("Issuance confirmation verified. You can now prepare the canonical registry files.");
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function prepareBootstrapRegistry() {
    setBusyAction("registry");
    setMessage("Rechecking confirmation and preparing canonical registry paths…");
    try {
      if (!bootstrapped || bootstrapped.deployment.confirmations < 1) throw new Error("Verify the issuance confirmation first.");
      const anchor = await traverseLiveAnchor(bootstrapped.deployment, esploraUrlForDeployment(bootstrapped.deployment));
      if (anchor.live.confirmations < 1) throw new Error("The issuance confirmation is no longer present. Check confirmation again before publishing.");
      const confirmedDeployment = localDeploymentSchema.parse({
        ...bootstrapped.deployment,
        activeAnchor: `${anchor.live.txid}:0`,
        confirmations: anchor.live.confirmations,
      });
      const snapshotPath = await registryPathForVerifierScript(confirmedDeployment.deploymentId, bootstrapped.snapshot.verifierScriptPubkey);
      const manifestPath = deploymentRegistryPath(confirmedDeployment.deploymentId);
      const confirmedBootstrap = { ...bootstrapped, deployment: confirmedDeployment };
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
    setImportError(undefined);
    setMessage("Validating the exact canonical manifest, live policy, and confirmed chain anchor…");
    try {
      const result = await validatePublicDeploymentImport(importValue);
      const local = await persistPublicDeploymentImport(result);
      setImportedDeployment(local);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.activeId }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }),
      ]);
      setMessage(`Public deployment ${shortHash(local.deploymentId)} imported and canonically verified. Holder use is ready; issuer control remains unattached.`);
    } catch (error) {
      const detail = userFacingError(error);
      setImportError(detail);
      setMessage(detail);
      requestAnimationFrame(() => importFieldRef.current?.focus());
    } finally {
      setBusyAction(undefined);
    }
  }

  async function attachImportedIssuerControl() {
    setBusyAction("attach");
    setMessage("Proving that the connected signer controls the manifest issuer key…");
    try {
      const selected = importedDeployment ?? requireDeployment(activeDeployment.data);
      const attached = await attachIssuerControl(selected);
      setImportedDeployment(attached);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }),
      ]);
      setMessage("Issuer control attached locally. The public manifest was not changed.");
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <AppShell eyebrow="Issuer console / Setup" title="Create or import a deployment">
      <BackLink to="/admin">Back to policy workspace</BackLink>
      {mode === "choose" && <div className="setup-choice-grid"><button className="choice-card" type="button" onClick={() => setMode("create")}><span className="choice-card-icon"><Rocket size={22} /></span><span className="choice-card-copy"><small>New deployment</small><strong>Create</strong><span>Issue the regulated asset, optional token, and one verifier unit with the local AMP Signer SDK.</span></span><ArrowRight size={19} /></button><button className="choice-card" type="button" onClick={() => setMode("import")}><span className="choice-card-icon"><Upload size={22} /></span><span className="choice-card-copy"><small>Existing deployment</small><strong>Import public deployment</strong><span>Verify canonical public data for holder use, then attach issuer control separately if needed.</span></span><ArrowRight size={19} /></button></div>}
      {mode === "create" && (
        <div className="setup-layout">
          <Panel className="setup-main">
            <button className="setup-chooser-return text-button" type="button" onClick={() => setMode("choose")}><ArrowRight size={14} /> Back to setup choices</button>
            <form className="form-stack" onSubmit={form.handleSubmit(preview)}>
              <SectionHeading label="Bootstrap configuration" title="Issue an asset" />
              <div className="form-grid-two">
                <label>Asset name<input aria-invalid={Boolean(form.formState.errors.name)} aria-describedby={form.formState.errors.name ? "setup-name-error" : undefined} {...form.register("name")} />{form.formState.errors.name && <small id="setup-name-error" className="field-error">{form.formState.errors.name.message}</small>}</label>
                <label>Ticker<input aria-invalid={Boolean(form.formState.errors.ticker)} aria-describedby={form.formState.errors.ticker ? "setup-ticker-error" : undefined} {...form.register("ticker")} />{form.formState.errors.ticker && <small id="setup-ticker-error" className="field-error">{form.formState.errors.ticker.message}</small>}</label>
                <label>Precision<input aria-invalid={Boolean(form.formState.errors.precision)} aria-describedby={form.formState.errors.precision ? "setup-precision-error" : undefined} type="number" {...form.register("precision", { valueAsNumber: true })} />{form.formState.errors.precision && <small id="setup-precision-error" className="field-error">{form.formState.errors.precision.message}</small>}</label>
                <label>Initial supply<input aria-invalid={Boolean(form.formState.errors.supply)} aria-describedby={form.formState.errors.supply ? "setup-supply-error" : undefined} inputMode="numeric" {...form.register("supply")} />{form.formState.errors.supply && <small id="setup-supply-error" className="field-error">{form.formState.errors.supply.message}</small>}</label>
              </div>
              <label>Network<select aria-invalid={Boolean(form.formState.errors.network)} aria-describedby={form.formState.errors.network ? "setup-network-error" : undefined} {...form.register("network")}><option value="liquid-testnet">Liquid testnet</option><option value="elements-regtest">Elements regtest</option></select>{form.formState.errors.network && <small id="setup-network-error" className="field-error">{form.formState.errors.network.message}</small>}</label>
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
                  <button className="button issuer-primary" disabled={Boolean(busyAction) || Boolean(bootstrapped) || !signer.connected || !signer.walletReady || !fundingReady} type="button" onClick={() => { setReviewIssuance(true); setMessage("Review the Liquid testnet issuance, fee, and destinations before signing."); }}>Review issuance <ArrowRight size={16} /></button>
                </div>
                {reviewIssuance && <div className="review-stack issuance-review" aria-label="Issuance review">
                  <div className="review-row"><span>Network</span><strong>{configuration.network === "liquid-testnet" ? "Liquid testnet" : "Elements regtest"}</strong></div>
                  <div className="review-row"><span>Funding</span><strong>{fundingPlan.confirmedOutputs} confirmed outputs · {formatUnits(fundingPlan.confirmedBalance, 8)} L-BTC</strong></div>
                  <div className="review-row"><span>Network fee</span><strong>0.00002 L-BTC</strong></div>
                  <div className="review-row"><span>Issued supply</span><strong>{configuration.supply} {configuration.ticker} base units</strong></div>
                  <div className="review-row"><span>Destinations</span><strong>Signer holder covenant{configuration.supplyMode === "issuer-managed" ? " + signer reissuance token" : ""}</strong></div>
                  <div className="review-buttons"><button className="button secondary" disabled={Boolean(busyAction)} type="button" onClick={() => setReviewIssuance(false)}>Back</button><button className="button issuer-primary" disabled={Boolean(busyAction) || Boolean(bootstrapped) || !signer.walletReady || !fundingReady} type="button" onClick={bootstrap}>{bootstrapped ? "Already broadcast" : busyAction === "issue" ? "Validating and signing…" : !signer.walletReady ? "Sync wallet before signing" : "Sign and broadcast"}</button></div>
                </div>}
              </div>
            )}
            {bootstrapped && <BootstrapRegistryState network={bootstrapped.deployment.network} txid={bootstrapped.deployment.genesisAnchor.split(":")[0]} assetId={bootstrapped.deployment.regulatedAsset} confirmations={bootstrapped.deployment.confirmations} publication={bootstrapped.deployment.publication} filesReady={Boolean(registryFiles)} busyAction={busyAction === "confirm" || busyAction === "registry" ? busyAction : undefined} onCheckConfirmation={() => void checkBootstrapConfirmation()} onPrepareRegistry={() => void prepareBootstrapRegistry()} />}
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
      {mode === "import" && <div className="setup-layout"><Panel className="setup-main"><button className="setup-chooser-return text-button" type="button" onClick={() => setMode("choose")}><ArrowRight size={14} /> Back to setup choices</button><SectionHeading label="Public deployment import" title="Manifest JSON or HTTPS URL" /><div className="form-stack"><label>Public source<textarea ref={importFieldRef} aria-invalid={Boolean(importError)} aria-describedby={importError ? "setup-import-error" : "setup-import-help"} rows={12} value={importValue} onChange={(event) => { setImportValue(event.target.value); setImportError(undefined); }} />{importError ? <small id="setup-import-error" className="field-error">{importError}</small> : <small id="setup-import-help">The manifest must be byte-identical on the canonical registry default branch.</small>}</label><button className="button issuer-primary wide" disabled={Boolean(busyAction) || !importValue.trim()} type="button" onClick={importDeployment}><ShieldCheck size={16} /> {busyAction === "import" ? "Verifying canonical data…" : "Import public deployment"}</button>{importedDeployment && <div className="issuer-attachment"><div><strong>Public import complete</strong><small>{importedDeployment.issuerProfileId === signer.profileId && importedDeployment.issuerDerivationIndex !== undefined ? "Issuer control is attached to the active signer profile." : "No issuer authority is attached to the active signer profile."}</small></div>{(importedDeployment.issuerProfileId !== signer.profileId || importedDeployment.issuerDerivationIndex === undefined) && <button className="button secondary" disabled={Boolean(busyAction) || !signer.connected} type="button" onClick={() => void attachImportedIssuerControl()}>{busyAction === "attach" ? "Proving control…" : "Attach issuer control"}</button>}</div>}</div>{message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}</Panel><aside className="setup-aside"><SafetyNote title="Role-neutral import">Holder use needs only canonical public data. Governance and reissuance stay locked until the connected signer separately proves the issuer key.</SafetyNote></aside></div>}
    </AppShell>
  );
}

export function AdminReissue() {
  const deployment = useActiveDeployment();
  const signerState = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const { anchor, policy } = useLivePolicy(deployment.data);
  const queryClient = useQueryClient();
  const [review, setReview] = useState<ReissueForm>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = useForm<ReissueForm>({ resolver: zodResolver(reissueSchema) });
  const receiptKey = operationReceiptQueryKey(deployment.data?.deploymentId, "reissuance", signerState.profileId);
  const receiptQuery = useQuery({
    queryKey: receiptKey,
    enabled: Boolean(deployment.data && signerState.connected && signerState.profileId),
    queryFn: async () => (await loadOperationReceipt(deployment.data!.deploymentId, "reissuance", signerState.profileId!)) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const receipt = receiptQuery.data ?? undefined;
  const broadcastInFlight = useRef(false);
  const activeDeploymentId = useRef(deployment.data?.deploymentId);
  activeDeploymentId.current = deployment.data?.deploymentId;

  useEffect(() => {
    setReview(undefined);
    setMessage(undefined);
    form.reset({ amount: "" });
  }, [deployment.data?.deploymentId, form, signerState.profileId]);

  useEffect(() => {
    const key = `reissuance:${deployment.data?.deploymentId ?? "none"}:${signerState.profileId ?? "locked"}`;
    setSignerOperationPending(key, Boolean(review || busy));
    return () => setSignerOperationPending(key, false);
  }, [busy, deployment.data?.deploymentId, review, signerState.profileId]);

  async function authorize() {
    if (!tryBeginOperation(broadcastInFlight, receipt)) return;
    setBusy(true);
    setMessage("Refreshing the live anchor, wallet funds, and reissuance token…");
    try {
      const selected = requirePublishedDeployment(deployment.data);
      if (selected.supplyMode !== "issuer-managed") throw new Error("This deployment has fixed supply.");
      if (!anchor.data || !policy.data) throw new Error("Resolve the live anchor and policy first.");
      if (!review) throw new Error("Review the reissuance first.");
      const esplora = esploraUrlForDeployment(selected);
      await requireFreshAnchor(selected, anchor.data.live, esplora);
      const signer = signerSnapshot();
      if (!signer.connected || !signer.profileId) throw new Error("Connect the AMP signer first.");
      if (selected.issuerDerivationIndex === undefined || selected.issuerProfileId !== signer.profileId) {
        throw new Error("Attach issuer control for the active signer profile before reissuing.");
      }
      const [wallet, verifierUtxo, recipient] = await Promise.all([
        synchronizeDeploymentWallet(selected, signer.profileId),
        liveAnchorUtxo(selected, anchor.data.live.txid),
        ensureSignerReceiveRecord(selected, signer.profileId),
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
      if (signerSnapshot().profileId !== signer.profileId) {
        throw new Error("The active signer profile changed before broadcast. Review the reissuance again.");
      }
      if (activeDeploymentId.current !== selected.deploymentId) {
        throw new Error("The active deployment changed before broadcast. Review the reissuance again.");
      }
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      const terminalReceipt = createOperationReceipt({
        deployment: selected,
        operation: "reissuance",
        txid: result.txid,
        amount: review.amount,
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
      setMessage(`Reissuance broadcast. Wallet and anchor synchronization have been requested.${receiptWarning ?? ""}`);
    } catch (error) {
      setMessage(userFacingError(error));
    } finally {
      finishOperation(broadcastInFlight);
      setBusy(false);
    }
  }

  async function startNewReissuance() {
    const selected = requireDeployment(deployment.data);
    if (!signerState.profileId) throw new Error("Connect the signer profile that created this receipt.");
    await dismissOperationReceipt(selected.deploymentId, "reissuance", signerState.profileId);
    queryClient.setQueryData(receiptKey, null);
    setReview(undefined);
    setMessage(undefined);
    form.reset({ amount: "" });
  }

  return (
    <AppShell eyebrow="Issuer console / Reissue" title="Mint governed supply">
      <BackLink to="/admin">Back to policy workspace</BackLink>
      <div className="setup-layout"><Panel className="setup-main"><SectionHeading label="Managed supply" title={receipt ? "Reissuance receipt" : review ? "Review the mint" : "Define the reissuance"} aside={<Pill tone="warn">Issuer governed</Pill>} />{!deployment.data ? <p>No deployment is selected. Create or import one in Setup before reissuing.</p> : deployment.data.publication !== "published" ? <div className="generate-record"><ShieldCheck size={26} /><p>The deployment is confirmed, but reissuance remains locked until canonical registry publication is verified.</p><Link className="button issuer-primary" to="/admin/setup">Finish registry publication</Link></div> : deployment.data.supplyMode !== "issuer-managed" ? <p>This deployment has fixed supply; reissuance is disabled.</p> : receipt ? <OperationReceiptPanel receipt={receipt} network={deployment.data.network} amountLabel={`${receipt.amount} ${receipt.ticker} base units`} resetLabel="Start a new reissuance" tone="issuer" onReset={() => void startNewReissuance()} /> : !review ? <form className="form-stack" onSubmit={form.handleSubmit(setReview)}><label>New base units<input aria-invalid={Boolean(form.formState.errors.amount)} aria-describedby={form.formState.errors.amount ? "reissue-amount-error" : "reissue-amount-help"} inputMode="numeric" {...form.register("amount")} />{form.formState.errors.amount ? <small id="reissue-amount-error" className="field-error">{form.formState.errors.amount.message}</small> : <small id="reissue-amount-help">The protocol reviews and commits the amount; it has no public reason field.</small>}</label><button className="button issuer-primary wide" type="submit">Review reissuance <ArrowRight size={16} /></button></form> : <div className="review-stack"><div className="review-row"><span>New units</span><strong>{review.amount}</strong></div><div className="review-row"><span>Verifier</span><strong>Same script, governance spend</strong></div><div className="review-row"><span>Destination</span><strong>Validated holder covenant</strong></div><div className="review-buttons"><button className="button secondary" disabled={busy} type="button" onClick={() => setReview(undefined)}>Edit</button><button className="button issuer-primary" disabled={busy || receiptQuery.isPending || !signerState.walletReady} type="button" onClick={authorize}>{busy ? "Validating and signing…" : !signerState.walletReady ? "Sync wallet before signing" : "Sign locally"} <ArrowRight size={16} /></button></div></div>}{message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}</Panel><aside className="setup-aside"><div className="risk-note"><AlertTriangle size={18} /><p><strong>Issuer authority</strong>The AMP Signer SDK verifies the current anchor, token, holder destination, recreated script, explicit assets, and exact fee before using issuer secrets.</p></div><Panel><h3>Required checks</h3><ul className="check-list"><li><RefreshCw size={15} /> Fresh winning anchor</li><li><Check size={15} /> Token returned</li><li><Check size={15} /> Same verifier script</li><li><Check size={15} /> Holder-only new supply</li></ul></Panel></aside></div>
    </AppShell>
  );
}
