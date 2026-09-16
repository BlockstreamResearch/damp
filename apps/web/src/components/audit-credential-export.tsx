import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeploymentManifest } from "../lib/domain";
import { deriveDampKey, exportAuditCredentials, signerSessionRevision, signerSnapshot, subscribeSigner } from "../lib/damp-signer";
import { discoverIssuerTransactions } from "../lib/audit-issuer-history";
import { esploraUrlForDeployment } from "../lib/esplora";
import { downloadBlob } from "../lib/download-json";
import { RegtestProviderSettings } from "./regtest-provider-settings";

/** Only public bytes leave the provider. Restricted credentials are created and downloaded locally. */
export function AuditCredentialExport({ deployment }: { deployment: DeploymentManifest }) {
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [offlineMessage, setOfflineMessage] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const connected = signer.connected && signer.network === deployment.network;
  async function exportCredentials(offline: boolean) {
    const abort = new AbortController();
    controller.current = abort;
    const revision = signerSessionRevision();
    setBusy(true); setMessage(""); setOfflineMessage(offline); setFailed(false);
    try {
      if (!connected) throw new Error("Connect this deployment's issuer signer first.");
      const issuer = await deriveDampKey(deployment.deploymentSalt, "issuer", deployment.network);
      if (issuer.publicKey !== deployment.issuerPublicKey) throw new Error("This signer is not the deployment's issuer. Open the signer menu and switch to the issuer's saved profile or recovery phrase.");
      let transactions: string[];
      if (offline) {
        if (!files.length || files.length > 1024 || files.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024)
          throw new Error("Choose bootstrap and every reissuance file, up to 1024 files and 24 MiB total.");
        transactions = await Promise.all(files.map(async (file) => {
          const raw = (await file.text()).trim();
          if (!/^(?:[0-9a-f]{2})+$/.test(raw) || raw.length > 8_000_000)
            throw new Error("Each offline file must contain one raw transaction in lowercase hex.");
          return raw;
        }));
      } else {
        transactions = await discoverIssuerTransactions(deployment, esploraUrlForDeployment(deployment), { signal: abort.signal, progress: setMessage });
      }
      abort.signal.throwIfAborted();
      if (signerSessionRevision() !== revision) throw new Error("The signer changed during discovery. Retry with the deployment's issuer signer.");
      const credentials = exportAuditCredentials(deployment, transactions);
      downloadBlob(credentials, "audit-credentials.json");
      setMessage(`${offline ? "Offline export downloaded. File selection does not establish complete history." : `Validated ${transactions.length} issuance transaction${transactions.length === 1 ? "" : "s"}. Credentials downloaded.`} Run the import command below, then delete the download and extra copies. Refresh credentials after any new reissuance.`);
    } catch (error) {
      if (!abort.signal.aborted) {
        setFailed(true); setMessage(error instanceof Error ? error.message : "Credential export failed. Retry discovery with the issuer signer.");
      }
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <details className="credential-export">
    <summary>Export issuer audit credentials</summary>
    <div className="credential-export-body">
      <p>Connect this deployment's issuer signer, then download credentials. The browser finds and validates its public bootstrap and reissuance transactions automatically.</p>
      <div className="credential-export-warning" id="audit-credential-privacy">
        <strong>Keep this file private.</strong>
        <p>It reveals this deployment's confidential amounts and signs issuer-certified reports. It contains no recovery phrase or spending key. Never publish it, upload it to the registry or put it in a URL.</p>
      </div>
      {!connected ? <div className="credential-signer-needed"><p>{signer.connected ? "Switch the signer to this deployment's network before exporting." : "Use the issuer's existing recovery phrase or saved profile. A new signer cannot authorize this deployment."}</p><button type="button" className="button secondary" onClick={() => document.getElementById("damp-signer-trigger")?.click()}>Connect issuer signer</button></div> : <p className="credential-file-help">Signer connected. Issuer control is checked locally before discovery; wallet funding is not required.</p>}
      {deployment.network === "elements-regtest" && <details className="report-requirements"><summary>Regtest public provider</summary><RegtestProviderSettings onSave={() => { setMessage(""); setFailed(false); }} /></details>}
      <button type="button" className="button secondary" disabled={busy || !connected} aria-describedby="audit-export-help" onClick={() => void exportCredentials(false)}>{busy && !offlineMessage ? "Discovering and validating…" : "Discover and download credentials"}</button>
      <p id="audit-export-help" className="credential-file-help">{!connected ? "Connect the issuer signer above to enable export. " : ""}Public Esplora sees the asset and transaction IDs. Incomplete or changing history blocks automatic export.</p>
      {message && !offlineMessage && <p role={failed ? "alert" : "status"} className={`credential-export-message${failed ? " error" : ""}`}>{message}</p>}
      <div className="credential-install"><span>Install the download in your private service directory</span><code>damp-report import-credentials CONFIG_FILE ~/Downloads/audit-credentials.json</code><p>This validates the file and creates a private copy with mode 600. Delete the original download and extra copies, then start the service. <a href="https://github.com/BlockstreamResearch/damp/blob/dev/README.md#signed-reports">First-time setup commands</a></p></div>
      <details className="credential-offline"><summary>Offline transaction files</summary><div className="credential-export-body">
        <p>Optional fallback for an offline signer or unavailable Esplora. Run <code>damp-report prepare-export CONFIG_FILE deployment.json issuer-export</code> against the synced provider in your service config, then select all generated .hex files. The <a href="https://github.com/BlockstreamResearch/damp/blob/dev/README.md#offline-export">offline guide</a> also supports export without a browser. File selection alone cannot establish complete history.</p>
        <label className="credential-export-files">Issuer transaction hex files<input type="file" multiple accept=".hex,.txt" aria-describedby="audit-credential-file-help audit-credential-privacy" disabled={busy} onChange={e => { setFiles(Array.from(e.target.files ?? [])); setMessage(""); setFailed(false); }} /></label>
        <p id="audit-credential-file-help" className="credential-file-help">{files.length ? `${files.length} file${files.length === 1 ? "" : "s"} selected.` : "Choose the bootstrap and every reissuance file to enable offline export."} Up to 1024 public hex files and 24 MiB total.</p>
        <button type="button" className="button secondary" disabled={busy || !connected || !files.length} onClick={() => void exportCredentials(true)}>{busy && offlineMessage ? "Validating offline files…" : "Download from offline files"}</button>
        {message && offlineMessage && <p role={failed ? "alert" : "status"} className={`credential-export-message${failed ? " error" : ""}`}>{message}</p>}
      </div></details>
    </div>
  </details>;
}
