import { useState } from "react";
import type { DeploymentManifest } from "../lib/domain";
import { exportAuditCredentials } from "../lib/damp-signer";
import { downloadBlob } from "../lib/download-json";

/** The selected files are public transaction bytes. Exported credentials stay local. */
export function AuditCredentialExport({ deployment }: { deployment: DeploymentManifest }) {
  const [files, setFiles] = useState<File[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function exportCredentials() {
    setBusy(true);
    setMessage("");
    try {
      if (!files.length || files.length > 1024 || files.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024)
        throw new Error("Choose bootstrap and issuer reissuance transaction hex files, up to 24 MiB total.");
      const transactions = await Promise.all(files.map(async (file) => {
        const raw = (await file.text()).trim();
        if (!/^(?:[0-9a-f]{2})+$/.test(raw) || raw.length > 8_000_000)
          throw new Error("Each file must contain one raw transaction in lowercase hex.");
        return raw;
      }));
      const credentials = exportAuditCredentials(deployment, transactions);
      downloadBlob(credentials, "audit-credentials.json");
      setMessage("Downloaded restricted credentials. Move the file into your private service directory and run chmod 600 on it before starting damp-report. Delete extra download copies.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Credential export failed.");
    } finally { setBusy(false); }
  }
  return <details>
    <summary>Export issuer audit credentials</summary>
    <p>Connect this deployment's issuer signer. Select its bootstrap and all issuer reissuance transaction hex files. These are public transaction bytes. Refresh this export after a new reissuance.</p>
    <p>The download can recover this deployment's confidential amounts and sign issuer-certified reports. It contains no recovery phrase or spending key. Keep it local and private; never upload it to the registry or put it in a URL. Browser downloads may initially have public file permissions.</p>
    <label>Issuer transaction hex files<input type="file" multiple accept=".hex,.txt" disabled={busy} onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setMessage(""); }} /></label>
    <button type="button" className="button secondary" disabled={busy || !files.length} onClick={() => void exportCredentials()}>{busy ? "Exporting…" : "Download audit credentials"}</button>
    {message && <p role="status">{message}</p>}
  </details>;
}
