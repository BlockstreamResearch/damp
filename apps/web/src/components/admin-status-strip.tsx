export function AdminStatusStrip({
  deploymentName,
  liveAnchorTxid,
  treeDepth,
  confirmations,
}: {
  deploymentName: string;
  liveAnchorTxid?: string;
  treeDepth?: number;
  confirmations: number;
}) {
  return (
    <section className="admin-status-strip" aria-label="Active deployment status">
      <div className="admin-status-item deployment">
        <span className="status-light" aria-hidden="true" />
        <span className="admin-status-copy">
          <small>Deployment</small>
          <strong title={deploymentName}>{deploymentName}</strong>
        </span>
      </div>
      <div className="admin-status-item">
        <small>Live anchor</small>
        {liveAnchorTxid
          ? <code title={liveAnchorTxid}>{liveAnchorTxid}</code>
          : <strong>Resolving…</strong>}
      </div>
      <div className="admin-status-item">
        <small>Depth / capacity</small>
        <strong>{treeDepth === undefined ? "Not resolved" : `D${treeDepth} / ${2 ** treeDepth}`}</strong>
      </div>
      <span className={`pill ${confirmations > 0 ? "good" : "warn"}`}>{confirmations} confirmations</span>
    </section>
  );
}
