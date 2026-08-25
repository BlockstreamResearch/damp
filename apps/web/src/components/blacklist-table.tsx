import { ListFilter, RotateCcw, Trash2 } from "lucide-react";

import { shortHash, type BlacklistEntry } from "../lib/domain";

export function BlacklistTable({
  entries,
  activeEntries,
  disabled = false,
  onRemove,
  onUndoRemoval,
}: {
  entries: BlacklistEntry[];
  activeEntries: BlacklistEntry[];
  disabled?: boolean;
  onRemove: (entry: BlacklistEntry) => void;
  onUndoRemoval: (entry: BlacklistEntry) => void;
}) {
  const draftOutpoints = new Set(entries.map((entry) => `${entry.txid}:${entry.vout}`));
  const activeOutpoints = new Set(activeEntries.map((entry) => `${entry.txid}:${entry.vout}`));
  const rows = [
    ...entries,
    ...activeEntries.filter((entry) => !draftOutpoints.has(`${entry.txid}:${entry.vout}`)),
  ];
  return (
    <div className="blacklist-table">
      <table>
        <caption className="sr-only">Exact outpoints in the active blacklist draft</caption>
        <thead><tr><th scope="col">Outpoint</th><th scope="col">Note</th><th scope="col">State</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {rows.map((entry) => {
            const outpoint = `${entry.txid}:${entry.vout}`;
            const active = activeOutpoints.has(outpoint);
            const removed = active && !draftOutpoints.has(outpoint);
            return (
              <tr key={outpoint}>
                <td data-label="Outpoint"><code>{shortHash(entry.txid, 10, 8)}:{entry.vout}</code></td>
                <td data-label="Note">{entry.note ?? "—"}</td>
                <td data-label="State"><span className={`pill ${removed ? "warn" : active ? "danger" : "warn"}`}>{removed ? "Removal drafted" : active ? "Blacklisted — cannot be spent" : "Addition drafted"}</span></td>
                <td data-label="Actions">{removed
                  ? <button aria-label={`Undo removal of outpoint ${shortHash(entry.txid, 8, 6)}:${entry.vout}`} className="icon-button" disabled={disabled} type="button" onClick={() => onUndoRemoval(entry)}><RotateCcw size={15} /></button>
                  : <button aria-label={`Remove outpoint ${shortHash(entry.txid, 8, 6)}:${entry.vout}`} className="icon-button" disabled={disabled} type="button" onClick={() => onRemove(entry)}><Trash2 size={15} /></button>}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td className="table-empty" colSpan={4}><ListFilter size={20} /> Empty blacklist.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
