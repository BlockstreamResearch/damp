export type AuditProgress = {
  phase: string;
  jobId: string;
  blocks?: number;
  headers?: number;
  height?: number;
  throughHeight?: number;
  transitions?: number;
  transactions?: number;
  outputs?: number;
  stage?: string;
  transactionIndexEnabled?: boolean;
};

export function auditProgressMessage(progress: AuditProgress): string {
  switch (progress.phase) {
    case "node-catching-up":
      if (progress.transactionIndexEnabled === false)
        return "Node prerequisite missing: enable txindex on your archival Elements node, then wait for chain and transaction index sync. Cancel this report while configuring the node.";
      return `Node catching up: ${progress.blocks ?? 0} blocks validated, ${progress.headers ?? 0} headers received. Waiting for chain and transaction index sync.`;
    case "index-catching-up":
      return `Index catching up: block ${progress.height} of ${progress.throughHeight}. Committed public history survives a restart.`;
    case "index-ready":
      return `History indexed through block ${progress.throughHeight}. Building report…`;
    case "report-building":
      return progress.stage === "recovery"
        ? `Recovering report: ${progress.transitions ?? 0} anchor transitions checked.`
        : `Checking ${progress.stage ?? "report"}: ${progress.transactions ?? progress.outputs ?? 0} records.`;
    case "index-reorg-check":
    case "index-rolled-back":
    case "index-rolling-back":
      return "Chain changed. Checking retained history and rolling back replaced blocks…";
    case "resuming":
      return "Resuming the report. After a service restart, confidential amounts are recovered again.";
    case "starting":
      return "Service authenticated. Checking provider and confirmed history; readiness is not yet established.";
    default:
      return "Preparing confirmed snapshot…";
  }
}

export function reportEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Use a report endpoint at http://127.0.0.1:PORT/report."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/report" || url.username || url.password || url.search || url.hash)
    throw new Error("Use a report endpoint at http://127.0.0.1:PORT/report.");
  return url;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Cooperative requests keep work bounded; secrets and results stay in memory. */
export async function buildAuditReport<T>(options: {
  url: URL;
  token: string;
  request: unknown;
  signal: AbortSignal;
  onProgress: (progress: AuditProgress) => void;
}): Promise<T> {
  const { url, token, signal, onProgress } = options;
  reportEndpoint(url.href);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  let jobId: string | undefined;
  let complete = false;
  async function send(body: unknown) {
    let response: Response;
    try {
      // Native recovery and archival provider calls can exceed two minutes.
      // Keep long advances cancellable by the user without imposing a shorter
      // client deadline that would discard the service's recovery progress.
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal, cache: "no-store", redirect: "error" });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error("Service unreachable or browser connection blocked. Check the local service and port, its allowed browser origin, and browser local-network permission. Retry from a local UI if Pages cannot connect.");
    }
    if (response.status === 401 || response.status === 403)
      throw new Error("Authentication failed. Enter the current local access token and check the service's allowed origin. Reset a lost token locally with damp-indexer token-reset; no mnemonic is needed.");
    if (response.status === 404)
      throw new Error("Report API unavailable. Start damp-report serve with your config, then check its port and /report path.");
    const value = await response.json() as AuditProgress & { error?: string };
    if (!response.ok) throw new Error(value.error ?? "Issuer service could not build a report.");
    return { response, value };
  }
  try {
    let { response, value } = await send({ action: "start", request: options.request });
    while (response.status === 202) {
      if (typeof value.jobId !== "string" || !value.jobId) throw new Error("Issuer service returned an invalid job identifier.");
      jobId = value.jobId;
      onProgress(value);
      await delay(value.phase === "node-catching-up" ? 2000 : 250, signal);
      ({ response, value } = await send({ action: "advance", jobId }));
    }
    complete = true;
    return value as T;
  } finally {
    if (jobId && !complete) {
      // A cancellation must reach the service even when the work request was
      // aborted. The service retains committed public index rows only.
      await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "cancel", jobId }), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) }).catch(() => undefined);
    }
  }
}
