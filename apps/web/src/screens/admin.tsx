import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AlertTriangle, ArrowRight, Check, Download, GitPullRequest, ListFilter, Minus, Plus, RefreshCw, Rocket, ShieldCheck, Trash2, Upload } from "lucide-react";

import { AppShell, BackLink, Panel, Pill, SafetyNote, SectionHeading, TechnicalDetails, WalletStatus } from "../components/ui";
import {
  bootstrap as bootstrapDeployment,
  buildBlacklist,
  createReceiveRecord,
  deriveAmpKey,
  deriveWalletAddress,
  reissue,
  signPolicyUpdate,
  validateDeployment,
  validatePolicySnapshot,
  validateReceiveRecord,
  validateReceiveRecordShape,
} from "../lib/amp-signer";
import {
  broadcastTransaction,
  findTokenUtxo,
  inspectAndFilter,
  liveAnchorUtxo,
  scanWalletAt,
  scanWalletUtxos,
} from "../lib/chain-wallet";
import {
  deploymentQueryKeys,
  useActiveDeployment,
} from "../lib/deployments";
import {
  blacklistEntrySchema,
  deploymentManifestSchema,
  localDeploymentSchema,
  policySnapshotSchema,
  publicManifest,
  receiveRecordSchema,
  requireDeployment,
  requirePublishedDeployment,
  shortHash,
  smallestTreeDepth,
  type BlacklistEntry,
  type Deployment,
  type DeploymentManifest,
  type PolicySnapshot,
} from "../lib/domain";
import { AnchorConflictError, esploraUrlForDeployment, requireFreshAnchor, traverseLiveAnchor } from "../lib/esplora";
import {
  canonicalRegistryContent,
  finishGitHubDeviceFlow,
  publishRegistryFile,
  registryPathForVerifierScript,
  startGitHubDeviceFlow,
  waitForCanonicalRegistryFile,
} from "../lib/github";
import { buildSuccessorPolicy, resolvePolicySnapshot, sha256Hex } from "../lib/policy-registry";
import {
  getDraft,
  listReceiveRecords,
  putDeployment,
  putDraft,
  putPolicySnapshot,
  putReceiveRecord,
  setActiveDeploymentId,
} from "../lib/store";

type DeviceAuthorization = Awaited<ReturnType<typeof startGitHubDeviceFlow>>;

const entryFormSchema = z.object({
  outpoint: z.string().regex(/^[0-9a-f]{64}:[0-9]+$/, "Use exact lowercase txid:vout format"),
  note: z.string().trim().max(280).optional(),
});
type EntryForm = z.infer<typeof entryFormSchema>;

function useLivePolicy(deployment: Deployment | undefined) {
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
  const [device, setDevice] = useState<DeviceAuthorization>();
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
      if (storedPending?.parentPolicyRoot === current.policyRoot) setPending(storedPending);
    });
  }, [deployment.data, loadedPolicy, policy.data]);

  useEffect(() => {
    if (deployment.data && loadedPolicy) void putDraft(deployment.data.deploymentId, "blacklist", draft);
  }, [deployment.data, draft, loadedPolicy]);

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

  async function authorizeGitHub() {
    try {
      const authorization = await startGitHubDeviceFlow();
      setDevice(authorization);
      window.open(authorization.verification_uri, "_blank", "noopener,noreferrer");
      await finishGitHubDeviceFlow(authorization);
      setMessage("GitHub authorized for this page session.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function publish() {
    setBusy(true);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      const current = policy.data;
      if (!current) throw new Error("Resolve the canonical live policy first.");
      const successor = await buildSuccessorPolicy(selected, current, draft);
      const path = await registryPathForVerifierScript(selected.deploymentId, successor.verifierScriptPubkey);
      const pullRequest = await publishRegistryFile({
        path,
        content: successor,
        title: `registry: ${selected.asset.ticker} policy ${successor.sequence}`,
        body: `Blacklist-only depth ${successor.treeDepth} snapshot. Governance activation is gated on exact default-branch bytes.`,
      });
      setPending(successor);
      await putDraft(selected.deploymentId, "pending-policy", successor);
      setMessage(`Pull request opened: ${pullRequest.html_url}. Merge it before activation.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setBusy(true);
    try {
      const selected = requirePublishedDeployment(deployment.data);
      const current = policy.data;
      const originalAnchor = anchor.data;
      const successor = pending ?? await getDraft<PolicySnapshot>(selected.deploymentId, "pending-policy");
      if (!current || !originalAnchor || !successor) throw new Error("Publish a successor snapshot first.");
      const path = await registryPathForVerifierScript(selected.deploymentId, successor.verifierScriptPubkey);
      await waitForCanonicalRegistryFile({ path, content: successor });
      const esplora = esploraUrlForDeployment(selected);
      await requireFreshAnchor(selected, originalAnchor.live, esplora);
      const [verifierUtxo, walletUtxos] = await Promise.all([
        liveAnchorUtxo(selected, originalAnchor.live.txid),
        scanWalletUtxos(selected),
      ]);
      const fees = await inspectAndFilter(walletUtxos, selected.policyAsset);
      await requireFreshAnchor(selected, originalAnchor.live, esplora);
      if (selected.issuerDerivationIndex === undefined) {
        throw new Error("This deployment has no local issuer-key locator.");
      }
      const result = await signPolicyUpdate({
        deployment: publicManifest(selected),
        currentPolicy: current,
        successorPolicy: successor,
        verifierUtxo,
        feeUtxos: fees.utxos,
        fee: "1500",
        issuerDerivationIndex: selected.issuerDerivationIndex,
      });
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      const winning = await waitForAnchor(selected, successor.verifierScriptPubkey);
      await putDeployment({ ...selected, activeAnchor: `${winning.live.txid}:0`, confirmations: winning.live.confirmations });
      await putPolicySnapshot(successor, await sha256Hex(successor.verifierScriptPubkey));
      setPending(undefined);
      setLoadedPolicy(undefined);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["anchor", selected.deploymentId] }), queryClient.invalidateQueries({ queryKey: ["policy", selected.deploymentId] }), queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active })]);
      setMessage(`Policy ${successor.sequence} active at ${winning.live.txid}:0.`);
    } catch (error) {
      if (error instanceof AnchorConflictError && deployment.data) {
        setPending(undefined);
        await putDraft(deployment.data.deploymentId, "pending-policy", null);
      }
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const selected = deployment.data;
  return (
    <AppShell role="issuer" eyebrow="Issuer console" title="Exact-outpoint blacklist" action={<WalletStatus />}>
      {!selected ? <div className="empty-state"><ListFilter size={24} /><h2>No active deployment</h2><p>Create or import one before editing policy.</p></div> : <>
        <div className="admin-status-strip"><div><span className="status-light" /><span><small>Deployment</small><strong>{selected.asset.name}</strong></span></div><div><small>Live anchor</small><strong>{anchor.data ? shortHash(anchor.data.live.txid) : "Resolving…"}</strong></div><div><small>Depth / capacity</small><strong>D{policy.data?.treeDepth ?? "–"} / {policy.data ? 2 ** policy.data.treeDepth : "–"}</strong></div><Pill tone={anchor.data?.live.confirmations ? "good" : "warn"}>{anchor.data?.live.confirmations ?? 0} confirmations</Pill></div>
        <div className="admin-grid">
          <Panel className="policy-editor"><SectionHeading label="Policy entries" title={`${draft.length} exact outpoint${draft.length === 1 ? "" : "s"}`} aside={<Pill tone={changes.added || changes.removed ? "warn" : "neutral"}>{changes.added + changes.removed} changes</Pill>} />
            <form className="inline-add-form" onSubmit={form.handleSubmit(addEntry)}><label>Exact outpoint<input placeholder="txid:vout" spellCheck={false} {...form.register("outpoint")} /></label><label>Internal note <span>(not consensus)</span><input {...form.register("note")} /></label><button className="button issuer-primary" type="submit"><Plus size={16} /> Add</button>{form.formState.errors.outpoint && <small className="field-error form-wide">{form.formState.errors.outpoint.message}</small>}</form>
            <div className="blacklist-table" role="table"><div className="table-head" role="row"><span>Outpoint</span><span>Note</span><span>State</span><span /></div>{draft.map((entry) => <div className="table-row" role="row" key={`${entry.txid}:${entry.vout}`}><code>{shortHash(entry.txid, 10, 8)}:{entry.vout}</code><span>{entry.note ?? "—"}</span><span><Pill>Draft</Pill></span><button aria-label="Remove outpoint" className="icon-button" type="button" onClick={() => setDraft((entries) => entries.filter((candidate) => candidate !== entry))}><Trash2 size={15} /></button></div>)}{draft.length === 0 && <div className="table-empty"><ListFilter size={20} /> Empty blacklist.</div>}</div>
          </Panel>
          <aside className="policy-sidebar"><Panel><SectionHeading label="Iterative capacity" title={`Depth ${depth} · ${2 ** depth} entries`} /><div className="diff-counts"><div><Plus size={15} /><span><strong>{changes.added}</strong> added</span></div><div><Minus size={15} /><span><strong>{changes.removed}</strong> removed</span></div></div><div className="root-preview"><small>Next policy digest</small><code>{preview.data ? shortHash(preview.data.policyRoot, 12, 10) : "Calculating…"}</code></div><button className="button secondary wide" type="button" onClick={() => setDraft(policy.data?.entries ?? [])}>Discard draft</button></Panel><SafetyNote title="Two-phase activation">The exact immutable snapshot must be retrievable from the canonical default branch before the local signer authorizes governance.</SafetyNote></aside>
        </div>
        <Panel className="publish-flow"><SectionHeading label="Publish and authorize" title="Move this draft on chain" /><div className="publish-steps"><div><span>1</span><div><strong>Authorize GitHub</strong><small>Token stays in memory</small></div><button className="button secondary" type="button" onClick={authorizeGitHub}>Connect</button></div><div><span>2</span><div><strong>Open snapshot PR</strong><small>D{depth}, exact canonical bytes</small></div><button className="button secondary" disabled={busy || !(changes.added || changes.removed)} type="button" onClick={publish}><GitPullRequest size={15} /> Open PR</button></div><div><span>3</span><div><strong>Activate governance leaf</strong><small>Waits for merge and rechecks anchor</small></div><button className="button issuer-primary" disabled={busy || !pending} type="button" onClick={activate}>Review update <ArrowRight size={15} /></button></div></div>{device && <div className="device-code"><span>GitHub code</span><strong>{device.user_code}</strong><a href={device.verification_uri} target="_blank" rel="noreferrer">Open GitHub</a></div>}{message && <p className="inline-message" role="status">{message}</p>}</Panel>
        <TechnicalDetails label="Policy commitment details"><dl className="detail-grid"><div><dt>Policy profile</dt><dd>Blacklist non-membership only</dd></div><div><dt>Key</dt><dd>SHA256(consensus_txid || big_endian(vout))</dd></div><div><dt>Supported depths</dt><dd>4, 5, 6</dd></div><div><dt>PoC transaction limit</dt><dd>10 regulated inputs and outputs</dd></div></dl></TechnicalDetails>
      </>}
    </AppShell>
  );
}

async function waitForAnchor(deployment: Deployment, expectedScript: string) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const anchor = await traverseLiveAnchor(deployment, esploraUrlForDeployment(deployment));
    if (anchor.live.scriptPubkey === expectedScript && anchor.live.confirmations > 0) return anchor;
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
  policyAsset: z.string().regex(/^[0-9a-f]{64}$/),
});
type SetupForm = z.infer<typeof setupSchema>;

type BootstrapState = { deployment: Deployment; snapshot: PolicySnapshot };

export function AdminSetup() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"choose" | "create" | "import">("choose");
  const [configuration, setConfiguration] = useState<SetupForm>();
  const [salt, setSalt] = useState<string>();
  const [bootstrapped, setBootstrapped] = useState<BootstrapState>();
  const [fundingAddress, setFundingAddress] = useState<string>();
  const [importValue, setImportValue] = useState("");
  const [message, setMessage] = useState<string>();
  const form = useForm<SetupForm>({ resolver: zodResolver(setupSchema), defaultValues: { name: "", ticker: "", precision: 8, supply: "", supplyMode: "fixed", network: "liquid-testnet", policyAsset: "" } });

  async function preview(value: SetupForm) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const deploymentSalt = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    setConfiguration(value);
    setSalt(deploymentSalt);
    setFundingAddress((await deriveWalletAddress(0, 0, value.network)).confidentialAddress);
    await putDraft("setup", "recovery", { protocol: "simplicity-amp/v0.1", deploymentSalt, ...value });
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
    try {
      if (!configuration || !salt) throw new Error("Prepare and save recovery data first.");
      const esplora = esploraUrlForDeployment({ network: configuration.network });
      const walletUtxos = await scanWalletAt(esplora, 10, configuration.network);
      const policy = await inspectAndFilter(walletUtxos, configuration.policyAsset);
      if (policy.utxos.length < 2) {
        throw new Error("Bootstrap requires two confirmed policy-asset UTXOs in the signer wallet.");
      }
      const result = await bootstrapDeployment({
        network: configuration.network,
        policyAsset: configuration.policyAsset,
        deploymentSalt: salt,
        asset: { name: configuration.name, ticker: configuration.ticker, precision: configuration.precision },
        issuedSupply: configuration.supply,
        supplyMode: configuration.supplyMode,
        policyUtxos: policy.utxos,
        fee: "2000",
        requiredConfirmations: 1,
        receiveAlias: configuration.ticker.toLowerCase(),
      });
      const broadcastTxid = await broadcastTransaction(configuration, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different bootstrap transaction ID.");
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
      await putDeployment(local);
      await setActiveDeploymentId(deploymentId);
      await putPolicySnapshot(snapshot, await sha256Hex(snapshot.verifierScriptPubkey));
      await putReceiveRecord(initialReceiveRecord, result.holderDerivationIndex);
      setBootstrapped({ deployment: local, snapshot });
      await queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all });
      setMessage(`Bootstrap broadcast: ${result.txid}. Confirm it before publishing.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function publishBootstrap() {
    try {
      if (!bootstrapped) throw new Error("Bootstrap a deployment first.");
      const anchor = await traverseLiveAnchor(bootstrapped.deployment, esploraUrlForDeployment(bootstrapped.deployment));
      if (anchor.live.confirmations < 1) throw new Error("Bootstrap is not confirmed yet.");
      const manifest = publicManifest(bootstrapped.deployment);
      const snapshotPath = await registryPathForVerifierScript(bootstrapped.deployment.deploymentId, bootstrapped.snapshot.verifierScriptPubkey);
      await publishRegistryFile({ path: `deployments/${bootstrapped.deployment.deploymentId}.json`, content: manifest, title: `registry: add ${bootstrapped.deployment.asset.ticker}`, body: "Immutable AMP v0.1 deployment manifest." });
      await publishRegistryFile({ path: snapshotPath, content: bootstrapped.snapshot, title: `registry: add ${bootstrapped.deployment.asset.ticker} genesis policy`, body: "Empty depth-4 genesis blacklist snapshot." });
      setMessage("Manifest and initial-policy pull requests opened. Merge both, then import or refresh the deployment.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function importDeployment() {
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
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <AppShell role="issuer" eyebrow="Issuer console / Setup" title="Create or import a deployment">
      <BackLink to="/admin">Back to policy workspace</BackLink>
      {mode === "choose" && <div className="setup-choice-grid"><button className="choice-card" type="button" onClick={() => setMode("create")}><span><Rocket size={22} /></span><div><small>New deployment</small><h2>Create</h2><p>Issue the regulated asset, optional token, and one verifier unit with the local AMP Signer SDK.</p></div><ArrowRight size={19} /></button><button className="choice-card" type="button" onClick={() => setMode("import")}><span><Upload size={22} /></span><div><small>Existing deployment</small><h2>Import</h2><p>Validate the manifest, canonical live policy, chain anchor, and issuer key.</p></div><ArrowRight size={19} /></button></div>}
      {mode === "create" && <div className="setup-layout"><Panel className="setup-main"><form className="form-stack" onSubmit={form.handleSubmit(preview)}><SectionHeading label="Bootstrap configuration" title="Asset and supply" /><div className="form-grid-two"><label>Asset name<input {...form.register("name")} /></label><label>Ticker<input {...form.register("ticker")} /></label><label>Precision<input type="number" {...form.register("precision", { valueAsNumber: true })} /></label><label>Initial supply<input inputMode="numeric" {...form.register("supply")} /></label></div><label>Policy asset ID<input spellCheck={false} {...form.register("policyAsset")} /></label><label>Network<select {...form.register("network")}><option value="liquid-testnet">Liquid testnet</option><option value="elements-regtest">Elements regtest</option></select></label><fieldset><legend>Supply model</legend><label className="radio-card"><input type="radio" value="fixed" {...form.register("supplyMode")} /><span><strong>Fixed</strong><small>Destroy the regulated-asset reissuance token.</small></span></label><label className="radio-card"><input type="radio" value="issuer-managed" {...form.register("supplyMode")} /><span><strong>Issuer managed</strong><small>The signer wallet retains the confidential reissuance token.</small></span></label></fieldset><button className="button issuer-primary wide" type="submit">Prepare recovery data</button></form>{configuration && salt && <div className="setup-step"><pre>{canonicalRegistryContent({ deploymentSalt: salt, ...configuration, fundingAddress })}</pre><p>Fund <strong>{fundingAddress}</strong> with at least two confirmed policy-asset UTXOs before continuing.</p><div className="review-buttons"><button className="button secondary" type="button" onClick={downloadRecovery}><Download size={16} /> Save recovery</button><button className="button issuer-primary" type="button" onClick={bootstrap}>Bootstrap locally</button></div></div>}{bootstrapped && <button className="button issuer-primary wide" type="button" onClick={publishBootstrap}><GitPullRequest size={16} /> Publish confirmed manifest and D4 policy</button>}{message && <p className="inline-message" role="status">{message}</p>}</Panel><aside className="setup-aside"><SafetyNote title="Small first tree">Every deployment starts with the D4 verifier. Governance upgrades to D5 or D6 only when the blacklist grows.</SafetyNote></aside></div>}
      {mode === "import" && <div className="setup-layout"><Panel className="setup-main"><SectionHeading label="Import deployment" title="Manifest JSON or URL" /><div className="form-stack"><label>Public source<textarea rows={12} value={importValue} onChange={(event) => setImportValue(event.target.value)} /></label><button className="button issuer-primary wide" type="button" onClick={importDeployment}><ShieldCheck size={16} /> Validate and prove issuer control</button></div>{message && <p className="inline-message" role="status">{message}</p>}</Panel></div>}
    </AppShell>
  );
}

const reissueSchema = z.object({ amount: z.string().regex(/^[1-9][0-9]*$/), reason: z.string().trim().min(3).max(280) });
type ReissueForm = z.infer<typeof reissueSchema>;

export function AdminReissue() {
  const deployment = useActiveDeployment();
  const { anchor, policy } = useLivePolicy(deployment.data);
  const [review, setReview] = useState<ReissueForm>();
  const [message, setMessage] = useState<string>();
  const form = useForm<ReissueForm>({ resolver: zodResolver(reissueSchema) });

  async function authorize() {
    try {
      const selected = requirePublishedDeployment(deployment.data);
      if (selected.supplyMode !== "issuer-managed") throw new Error("This deployment has fixed supply.");
      if (!anchor.data || !policy.data) throw new Error("Resolve the live anchor and policy first.");
      if (!review) throw new Error("Review the reissuance first.");
      const esplora = esploraUrlForDeployment(selected);
      await requireFreshAnchor(selected, anchor.data.live, esplora);
      let stored = (await listReceiveRecords(selected.deploymentId))[0];
      if (!stored) {
        const created = await createReceiveRecord(publicManifest(selected), selected.deploymentId, `${selected.asset.ticker.toLowerCase()}-issuer`);
        const record = receiveRecordSchema.parse(created.record);
        await validateReceiveRecordShape(record);
        await validateReceiveRecord(publicManifest(selected), record);
        await putReceiveRecord(record, created.derivationIndex);
        stored = { record, derivationIndex: created.derivationIndex };
      }
      if (selected.issuerDerivationIndex === undefined) {
        throw new Error("This deployment has no local issuer-key locator.");
      }
      const [walletUtxos, verifierUtxo] = await Promise.all([
        scanWalletUtxos(selected),
        liveAnchorUtxo(selected, anchor.data.live.txid),
      ]);
      const [fees, tokenUtxo] = await Promise.all([
        inspectAndFilter(walletUtxos, selected.policyAsset),
        findTokenUtxo(selected, walletUtxos),
      ]);
      await requireFreshAnchor(selected, anchor.data.live, esplora);
      const result = await reissue({
        deployment: publicManifest(selected),
        currentPolicy: policy.data,
        verifierUtxo,
        tokenUtxo,
        feeUtxos: fees.utxos.filter((utxo) => utxo !== tokenUtxo),
        recipient: stored.record,
        amount: review.amount,
        fee: "2000",
        issuerDerivationIndex: selected.issuerDerivationIndex,
      });
      const broadcastTxid = await broadcastTransaction(selected, result.transaction);
      if (broadcastTxid !== result.txid) throw new Error("Esplora returned a different transaction ID.");
      setMessage(`Reissuance broadcast: ${result.txid}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <AppShell role="issuer" eyebrow="Issuer console / Reissue" title="Mint governed supply">
      <BackLink to="/admin">Back to policy workspace</BackLink>
      <div className="setup-layout"><Panel className="setup-main"><SectionHeading label="Managed supply" title={review ? "Review the mint" : "Define the reissuance"} aside={<Pill tone="warn">Issuer governed</Pill>} />{deployment.data?.supplyMode !== "issuer-managed" ? <p>This deployment is fixed-supply; reissuance is disabled.</p> : !review ? <form className="form-stack" onSubmit={form.handleSubmit(setReview)}><label>New base units<input inputMode="numeric" {...form.register("amount")} /></label><label>Public reason<textarea rows={4} {...form.register("reason")} /></label><button className="button issuer-primary wide" type="submit">Review reissuance <ArrowRight size={16} /></button></form> : <div className="review-stack"><div className="review-row"><span>New units</span><strong>{review.amount}</strong></div><div className="review-row"><span>Verifier</span><strong>Same script, governance spend</strong></div><div className="review-row"><span>Destination</span><strong>Validated holder covenant</strong></div><div className="review-buttons"><button className="button secondary" type="button" onClick={() => setReview(undefined)}>Edit</button><button className="button issuer-primary" type="button" onClick={authorize}>Sign locally <ArrowRight size={16} /></button></div></div>}{message && <p className="inline-message" role="status">{message}</p>}</Panel><aside className="setup-aside"><div className="risk-note"><AlertTriangle size={18} /><p><strong>Issuer authority</strong>The AMP Signer SDK verifies the current anchor, token, holder destination, recreated script, explicit assets, and exact fee before using issuer secrets.</p></div><Panel><h3>Required checks</h3><ul className="check-list"><li><RefreshCw size={15} /> Fresh winning anchor</li><li><Check size={15} /> Token returned</li><li><Check size={15} /> Same verifier script</li><li><Check size={15} /> Holder-only new supply</li></ul></Panel></aside></div>
    </AppShell>
  );
}
