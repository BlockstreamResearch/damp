import { ListFilter, Trash2 } from "lucide-react";

import { shortHash, type BlacklistEntry } from "../lib/domain";

export function BlacklistTable({
  entries,
  activeOutpoints,
  disabled = false,
  onRemove,
}: {
  entries: BlacklistEntry[];
  activeOutpoints: ReadonlySet<string>;
  disabled?: boolean;
  onRemove: (entry: BlacklistEntry) => void;
}) {
  return (
    <div className="blacklist-table">
      <table>
        <caption className="sr-only">Exact outpoints in the active blacklist draft</caption>
        <thead><tr><th scope="col">Outpoint</th><th scope="col">Note</th><th scope="col">State</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {entries.map((entry) => {
            const outpoint = `${entry.txid}:${entry.vout}`;
            const active = activeOutpoints.has(outpoint);
            return (
              <tr key={outpoint}>
                <td data-label="Outpoint"><code>{shortHash(entry.txid, 10, 8)}:{entry.vout}</code></td>
                <td data-label="Note">{entry.note ?? "—"}</td>
                <td data-label="State"><span className={`pill ${active ? "good" : "neutral"}`}>{active ? "Active" : "Draft"}</span></td>
                <td data-label="Actions"><button aria-label={`Remove outpoint ${shortHash(entry.txid, 8, 6)}:${entry.vout}`} className="icon-button" disabled={disabled} type="button" onClick={() => onRemove(entry)}><Trash2 size={15} /></button></td>
              </tr>
            );
          })}
          {entries.length === 0 && <tr><td className="table-empty" colSpan={4}><ListFilter size={20} /> Empty blacklist.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
