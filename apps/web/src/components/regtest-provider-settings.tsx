import { useId, useState } from "react";
import { publicEsploraUrl } from "../lib/audit-issuer-history";

export const regtestProviderKey = "simplicity-damp:regtest-esplora";
export function RegtestProviderSettings({ onSave }: { onSave?: (url: string) => void }) {
  const [value, setValue] = useState(() => localStorage.getItem(regtestProviderKey) ?? "");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const helpId = useId();
  function save() {
    try {
      const url = publicEsploraUrl(value);
      localStorage.setItem(regtestProviderKey, url);
      onSave?.(url);
      setFailed(false); setMessage("Provider saved. Continue the import or retry discovery.");
    } catch (error) {
      setFailed(true); setMessage(error instanceof Error ? error.message : "Could not save this browser's provider setting.");
    }
  }
  return <div className="regtest-provider-settings form-stack">
    <label>Regtest Esplora API URL<input type="url" value={value} placeholder="http://127.0.0.1:3002/api" aria-describedby={helpId} onChange={event => { setValue(event.target.value); setMessage(""); }} /></label>
    <p id={helpId}>Use the Esplora indexer connected to your deployment's Elements node. It must allow this browser origin. Ask the chain operator for its public API URL; do not enter an RPC URL or password.</p>
    <button type="button" className="button secondary" onClick={save}>Save public provider</button>
    {message && <p role={failed ? "alert" : "status"}>{message}</p>}
  </div>;
}
