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
};

export function auditProgressMessage(progress: AuditProgress): string {
  switch (progress.phase) {
    case "node-catching-up":
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
      return "Chain changed. Checking retained history and rolling back replaced blocks…";
    case "resuming":
      return "Resuming the report. After a service restart, confidential amounts are recovered again.";
    default:
      return "Preparing confirmed snapshot…";
  }
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
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  let jobId: string | undefined;
  let complete = false;
  async function send(body: unknown) {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal, cache: "no-store" });
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
      if (value.phase === "node-catching-up") await delay(2000, signal);
      ({ response, value } = await send({ action: "advance", jobId }));
    }
    complete = true;
    return value as T;
  } finally {
    if (jobId && !complete) {
      // A cancellation must reach the service even when the work request was
      // aborted. The service retains committed public index rows only.
      await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "cancel", jobId }), cache: "no-store", signal: AbortSignal.timeout(10000) }).catch(() => undefined);
    }
  }
}
