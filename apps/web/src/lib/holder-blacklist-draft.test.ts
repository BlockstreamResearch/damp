import { describe, expect, it } from "vitest";

import { updateHolderBlacklistDraft } from "./holder-blacklist-draft";

const txid = "11".repeat(32);

describe("holder blacklist draft", () => {
  it("adds and removes an eligible output without publishing anything", () => {
    const added = updateHolderBlacklistDraft({ activeDeploymentId: "a", rowDeploymentId: "a", draft: [], active: [], txid, vout: 2, status: "confirmed", action: "add" });
    expect(added).toEqual([{ txid, vout: 2, note: "Added from Holder outputs" }]);
    expect(updateHolderBlacklistDraft({ activeDeploymentId: "a", rowDeploymentId: "a", draft: added, active: [], txid, vout: 2, status: "confirmed", action: "remove" })).toEqual([]);
  });

  it("preserves both outputs when successive block actions use the latest draft", () => {
    const first = updateHolderBlacklistDraft({ activeDeploymentId: "a", rowDeploymentId: "a", draft: [], active: [], txid, vout: 2, status: "confirmed", action: "add" });
    const second = updateHolderBlacklistDraft({ activeDeploymentId: "a", rowDeploymentId: "a", draft: first, active: [], txid: "22".repeat(32), vout: 3, status: "confirmed", action: "add" });
    expect(second.map(({ txid: id, vout }) => `${id}:${vout}`)).toEqual([`${txid}:2`, `${"22".repeat(32)}:3`]);
  });

  it("rejects cross-deployment, pending, and already-active outputs", () => {
    const base = { activeDeploymentId: "a", rowDeploymentId: "a", draft: [], active: [], txid, vout: 2, status: "confirmed" as const, action: "add" as const };
    expect(() => updateHolderBlacklistDraft({ ...base, rowDeploymentId: "b" })).toThrow(/another deployment/i);
    expect(() => updateHolderBlacklistDraft({ ...base, status: "unconfirmed" })).toThrow(/confirmed, unspent/i);
    expect(() => updateHolderBlacklistDraft({ ...base, active: [{ txid, vout: 2 }] })).toThrow(/already in the active blacklist/i);
  });
});
