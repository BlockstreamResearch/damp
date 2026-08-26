import type { BlacklistEntry } from "./domain";

export function updateHolderBlacklistDraft(input: {
  activeDeploymentId: string;
  rowDeploymentId: string;
  draft: BlacklistEntry[];
  active: BlacklistEntry[];
  txid: string;
  vout: number;
  status: "confirmed" | "unconfirmed" | "spent" | "orphaned";
  action: "add" | "remove";
}) {
  if (input.activeDeploymentId !== input.rowDeploymentId) {
    throw new Error("The output belongs to another deployment.");
  }
  const outpoint = `${input.txid}:${input.vout}`;
  if (input.active.some((entry) => `${entry.txid}:${entry.vout}` === outpoint)) {
    throw new Error("The output is already in the active blacklist.");
  }
  if (input.action === "remove") {
    return input.draft.filter((entry) => `${entry.txid}:${entry.vout}` !== outpoint);
  }
  if (input.status !== "confirmed") throw new Error("Only confirmed, unspent outputs can be added to the draft.");
  if (input.draft.some((entry) => `${entry.txid}:${entry.vout}` === outpoint)) return input.draft;
  return [...input.draft, { txid: input.txid, vout: input.vout, note: "Added from Holder outputs" }];
}
