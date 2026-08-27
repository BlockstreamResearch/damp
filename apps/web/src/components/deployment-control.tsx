export function DeploymentControl({
  deployments,
  activeId,
  busy = false,
  onSelect,
}: {
  deployments: Array<{ deploymentId: string; asset: { ticker: string; name?: string } }>;
  activeId?: string;
  busy?: boolean;
  onSelect: (deploymentId: string) => void;
}) {
  const selected = deployments.find((deployment) => deployment.deploymentId === activeId) ?? deployments[0];
  const label = `${selected.asset.ticker} · ${selected.deploymentId.slice(0, 8)}`;
  if (deployments.length === 1) {
    return (
      <div className="deployment-selector deployment-current" aria-label="Active deployment">
        <span>Active deployment</span>
        <strong title={`${selected.asset.name ?? selected.asset.ticker} · ${selected.deploymentId}`}>{label}</strong>
      </div>
    );
  }
  return (
    <label className="deployment-selector">
      <span>Active deployment</span>
      <select aria-label="Active deployment" aria-busy={busy} disabled={busy} title={busy ? "Switching active deployment…" : `${selected.asset.name ?? selected.asset.ticker} · ${selected.deploymentId}`} value={selected.deploymentId} onChange={(event) => onSelect(event.target.value)}>
        {deployments.map((deployment) => <option key={deployment.deploymentId} value={deployment.deploymentId}>{deployment.asset.ticker} · {deployment.deploymentId.slice(0, 8)}</option>)}
      </select>
    </label>
  );
}
