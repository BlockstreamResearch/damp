export function blacklistScope(deploymentId: string, policyRoot: string) {
  return `${deploymentId}:${policyRoot}`;
}

export function blacklistDraftName(policyRoot: string) {
  return `blacklist:${policyRoot}`;
}

export function pendingPolicyDraftName(policyRoot: string) {
  return `pending-policy:${policyRoot}`;
}

export function isCurrentBlacklistLoad(activeToken: symbol | undefined, requestToken: symbol) {
  return activeToken === requestToken;
}

export function requireCurrentBlacklistScope(activeScope: string | undefined, expectedScope: string) {
  if (activeScope !== expectedScope) {
    throw new Error("The active deployment or policy changed. Reopen and review this blacklist operation.");
  }
}
