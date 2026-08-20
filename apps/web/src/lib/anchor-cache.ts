import type { Deployment } from "./domain";
import {
  anchorChanged,
  esploraUrlForDeployment,
  traverseLiveAnchor,
  type AnchorTraversal,
  type EsploraRequest,
} from "./esplora";
import { getCachedRecord, putCachedRecord } from "./store";

export type CachedAnchor = {
  traversal: AnchorTraversal;
  checkedAt: string;
};

export type AnchorRefresh = {
  current: CachedAnchor;
  previous?: CachedAnchor;
  change: "initial" | "none" | "reorg" | "winner";
};

/**
 * Refresh chain truth and atomically replace the public cache. A changed txid is a competing winner;
 * the same txid with a changed block hash or fewer confirmations is a reorg. Callers must discard
 * any derived policy/transaction cache for either event.
 */
export async function refreshCachedAnchor(
  deployment: Deployment,
  request: EsploraRequest = fetch,
): Promise<AnchorRefresh> {
  const key = `anchor:${deployment.deploymentId}`;
  const previous = await getCachedRecord<CachedAnchor>(key);
  const traversal = await traverseLiveAnchor(deployment, esploraUrlForDeployment(deployment), request);
  const current = { traversal, checkedAt: new Date().toISOString() };

  let change: AnchorRefresh["change"] = "initial";
  if (previous) {
    if (previous.traversal.live.txid !== traversal.live.txid) change = "winner";
    else if (
      anchorChanged(previous.traversal.live, traversal.live) ||
      traversal.live.confirmations < previous.traversal.live.confirmations
    ) change = "reorg";
    else change = "none";
  }

  await putCachedRecord(key, current);
  return { current, previous, change };
}
