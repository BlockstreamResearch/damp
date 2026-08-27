import { useQuery } from "@tanstack/react-query";

import { markSignerWalletReady, type SignerNetwork } from "./amp-signer";
import type { Deployment } from "./domain";
import {
  loadWalletSyncSnapshot,
  synchronizeBaseWallet,
  synchronizeDeploymentWallet,
  type WalletSyncSnapshot,
} from "./wallet-sync";

export const walletSyncQueryKeys = {
  all: ["wallet-sync"] as const,
  wallet: (profileId: string, network: SignerNetwork) => ["wallet-sync", profileId, network] as const,
  snapshot: (profileId: string, network: SignerNetwork, scope: string) => ["wallet-sync", profileId, network, scope] as const,
  persisted: (profileId: string, network: SignerNetwork, scope: string) => ["wallet-sync-persisted", profileId, network, scope] as const,
};

export type WalletSyncResult = { snapshot: WalletSyncSnapshot; syncError?: string };

export type WalletSyncPresentation = {
  state: "disconnected" | "loading" | "syncing" | "synced" | "stale" | "error";
  hasSnapshot: boolean;
  message?: string;
};

export function shouldShowPolicyBalanceChecking(input: {
  signerConnected: boolean;
  signerMatchesDeployment: boolean;
  deploymentPublished: boolean;
  policyPending: boolean;
  hasPolicy: boolean;
}) {
  return input.signerConnected
    && input.signerMatchesDeployment
    && input.deploymentPublished
    && input.policyPending
    && !input.hasPolicy;
}

export function walletSyncPresentation(input: {
  connected: boolean;
  snapshot?: WalletSyncSnapshot;
  pending?: boolean;
  fetching?: boolean;
  error?: unknown;
  syncError?: string;
}): WalletSyncPresentation {
  if (!input.connected) return { state: "disconnected", hasSnapshot: false };
  const hasSnapshot = Boolean(input.snapshot);
  const message = input.syncError
    ?? (input.error instanceof Error ? input.error.message : input.error ? String(input.error) : undefined);
  if (message) {
    return { state: hasSnapshot ? "stale" : "error", hasSnapshot, message };
  }
  if (!hasSnapshot && (input.pending || input.fetching)) return { state: "loading", hasSnapshot: false };
  if (!hasSnapshot) {
    return {
      state: "error",
      hasSnapshot: false,
      message: "Wallet synchronization did not produce a verified snapshot.",
    };
  }
  if (input.fetching) return { state: "syncing", hasSnapshot: true };
  return { state: "synced", hasSnapshot: true };
}

export function useDeploymentWalletSync(deployment: Deployment | null | undefined, profileId?: string) {
  const enabled = Boolean(deployment && profileId);
  const network = deployment?.network ?? "liquid-testnet";
  const scope = deployment?.deploymentId ?? "none";
  const persisted = useQuery({
    queryKey: walletSyncQueryKeys.persisted(profileId ?? "disconnected", network, scope),
    enabled,
    // React Query reserves `undefined` for a missing query result. IndexedDB
    // legitimately returns no snapshot on a first connection, so represent the
    // cache miss as null and let the live synchronization start normally.
    queryFn: async () => (await loadWalletSyncSnapshot(profileId!, network, scope)) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useQuery({
    queryKey: walletSyncQueryKeys.snapshot(profileId ?? "disconnected", network, scope),
    enabled: enabled && persisted.isFetched,
    queryFn: ({ signal }) => refreshDeploymentWallet(deployment!, profileId!, signal),
    placeholderData: persisted.data ? { snapshot: persisted.data } : undefined,
    refetchInterval: refetchInterval,
    refetchOnWindowFocus: true,
  });
}

export function useBaseWalletSync(input: {
  profileId?: string;
  network?: SignerNetwork;
  enabled?: boolean;
}) {
  const enabled = Boolean(input.enabled !== false && input.profileId && input.network);
  const profileId = input.profileId ?? "disconnected";
  const network = input.network ?? "liquid-testnet";
  const persisted = useQuery({
    queryKey: walletSyncQueryKeys.persisted(profileId, network, "base"),
    enabled,
    queryFn: async () => (await loadWalletSyncSnapshot(profileId, network, "base")) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useQuery({
    queryKey: walletSyncQueryKeys.snapshot(profileId, network, "base"),
    enabled: enabled && persisted.isFetched,
    queryFn: ({ signal }) => refreshBaseWallet({
      profileId,
      network,
    }, signal),
    placeholderData: persisted.data ? { snapshot: persisted.data } : undefined,
    refetchInterval: refetchInterval,
    refetchOnWindowFocus: true,
  });
}

export async function refreshDeploymentWallet(
  deployment: Deployment,
  profileId: string,
  signal?: AbortSignal,
): Promise<WalletSyncResult> {
  const previous = await loadWalletSyncSnapshot(profileId, deployment.network, deployment.deploymentId);
  try {
    const snapshot = await synchronizeDeploymentWallet(deployment, profileId, { signal });
    markSignerWalletReady(profileId, deployment.network);
    return { snapshot };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (!previous) throw error;
    return { snapshot: previous, syncError: error instanceof Error ? error.message : String(error) };
  }
}

export async function refreshBaseWallet(input: {
  profileId: string;
  network: SignerNetwork;
}, signal?: AbortSignal): Promise<WalletSyncResult> {
  const previous = await loadWalletSyncSnapshot(input.profileId, input.network, "base");
  try {
    const snapshot = await synchronizeBaseWallet({ ...input, signal });
    markSignerWalletReady(input.profileId, input.network);
    return { snapshot };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (!previous) throw error;
    return { snapshot: previous, syncError: error instanceof Error ? error.message : String(error) };
  }
}

function refetchInterval(query: { state: { data?: WalletSyncResult } }) {
  const pending = query.state.data?.snapshot.utxos.some((utxo) => utxo.status === "unconfirmed");
  return pending ? 10_000 : 60_000;
}
