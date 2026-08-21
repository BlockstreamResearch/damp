import { describe, expect, it } from "vitest";

import {
  blacklistDraftName,
  blacklistScope,
  isCurrentBlacklistLoad,
  pendingPolicyDraftName,
  requireCurrentBlacklistScope,
} from "./blacklist-drafts";

describe("blacklist workspace scoping", () => {
  it("isolates entries and pending successors by deployment and live policy root", () => {
    const deploymentA = "aa".repeat(32);
    const deploymentB = "bb".repeat(32);
    const rootOne = "11".repeat(32);
    const rootTwo = "22".repeat(32);

    expect(blacklistScope(deploymentA, rootOne)).not.toBe(blacklistScope(deploymentB, rootOne));
    expect(blacklistScope(deploymentA, rootOne)).not.toBe(blacklistScope(deploymentA, rootTwo));
    expect(blacklistDraftName(rootOne)).not.toBe(blacklistDraftName(rootTwo));
    expect(pendingPolicyDraftName(rootOne)).not.toBe(pendingPolicyDraftName(rootTwo));
  });

  it("rejects a stale async completion after a rapid scope switch", async () => {
    const first = Symbol("deployment-a:root-1");
    const second = Symbol("deployment-b:root-2");
    let active: symbol | undefined = first;
    const delayed = Promise.resolve().then(() => isCurrentBlacklistLoad(active, first));
    active = second;

    await expect(delayed).resolves.toBe(false);
    expect(isCurrentBlacklistLoad(active, second)).toBe(true);
    expect(() => requireCurrentBlacklistScope("deployment-b:root-2", "deployment-a:root-1")).toThrow(/active deployment or policy changed/i);
  });
});
