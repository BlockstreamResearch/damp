import { Download, ExternalLink, RefreshCw } from "lucide-react";

import { shortHash, type Deployment } from "../lib/domain";

export function BootstrapRegistryState({
  network,
  txid,
  assetId,
  confirmations,
  publication,
  filesReady,
  busyAction,
  onCheckConfirmation,
  onPrepareRegistry,
}: {
  network: Deployment["network"];
  txid: string;
  assetId: string;
  confirmations: number;
  publication: Deployment["publication"];
  filesReady: boolean;
  busyAction?: "confirm" | "registry";
  onCheckConfirmation: () => void;
  onPrepareRegistry: () => void;
}) {
  const confirmed = confirmations > 0;
  const registryState = publication === "published"
    ? "Published"
    : filesReady
      ? "Ready for manual publication"
      : confirmed
        ? "Confirmation verified"
        : "Pending confirmation check";

  return (
    <>
      <div className="review-stack bootstrap-result" aria-label="Bootstrap result">
        <div className="review-row"><span>Issued asset</span><strong><code title={assetId}>{shortHash(assetId, 12, 10)}</code></strong></div>
        <div className="review-row"><span>Issuance transaction</span><strong><code title={txid}>{shortHash(txid, 12, 10)}</code></strong></div>
        <div className="review-row"><span>Chain state</span><strong>{confirmed ? `${confirmations} confirmation${confirmations === 1 ? "" : "s"}` : "Awaiting confirmation"}</strong></div>
        <div className="review-row"><span>Registry state</span><strong>{registryState}</strong></div>
      </div>
      {(network === "liquid-testnet" || (publication !== "published" && !filesReady)) && (
        <div className="bootstrap-registry-actions" role="group" aria-label="Registry publication actions">
          {network === "liquid-testnet" && <a className="button secondary" href={`https://blockstream.info/liquidtestnet/tx/${txid}`} target="_blank" rel="noreferrer">View transaction <ExternalLink size={14} /></a>}
          {publication !== "published" && !filesReady && (!confirmed ? (
            <button className="button issuer-primary wide" disabled={Boolean(busyAction)} aria-busy={busyAction === "confirm"} type="button" onClick={onCheckConfirmation}><RefreshCw size={16} /> {busyAction === "confirm" ? "Checking confirmation…" : "Check transaction confirmation"}</button>
          ) : (
            <button className="button issuer-primary wide" disabled={Boolean(busyAction)} aria-busy={busyAction === "registry"} type="button" onClick={onPrepareRegistry}><Download size={16} /> {busyAction === "registry" ? "Preparing registry files…" : "Prepare confirmed registry files"}</button>
          ))}
        </div>
      )}
    </>
  );
}
