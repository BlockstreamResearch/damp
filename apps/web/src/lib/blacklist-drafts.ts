function profileScope(signerProfileId?: string) {
  return signerProfileId ?? "locked";
}

export function blacklistScope(deploymentId: string, policyRoot: string, signerProfileId?: string) {
  return `${deploymentId}:${policyRoot}:${profileScope(signerProfileId)}`;
}

export function blacklistDraftName(policyRoot: string, signerProfileId?: string) {
  return `blacklist:${policyRoot}:${profileScope(signerProfileId)}`;
}

export function pendingPolicyDraftName(policyRoot: string, signerProfileId?: string) {
  return `pending-policy:${policyRoot}:${profileScope(signerProfileId)}`;
}

export function isCurrentBlacklistLoad(activeToken: symbol | undefined, requestToken: symbol) {
  return activeToken === requestToken;
}

export function requireCurrentBlacklistScope(activeScope: string | undefined, expectedScope: string) {
  if (activeScope !== expectedScope) {
    throw new Error("The active deployment or policy changed. Reopen and review this blacklist operation.");
  }
}
