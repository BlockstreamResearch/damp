import { useQuery } from "@tanstack/react-query";

import type { SignerNetwork } from "./amp-signer";
import type { Deployment } from "./domain";
import {
  loadWalletSyncSnapshot,
  synchronizeBaseWallet,
  synchronizeDeploymentWallet,
  type WalletSyncSnapshot,
} from "./wallet-sync";

export const walletSyncQueryKeys = {
  all: ["wallet-sync"] as const,
  wallet: (fingerprint: string, network: SignerNetwork) => ["wallet-sync", fingerprint, network] as const,
  snapshot: (fingerprint: string, network: SignerNetwork, scope: string) => ["wallet-sync", fingerprint, network, scope] as const,
  persisted: (fingerprint: string, network: SignerNetwork, scope: string) => ["wallet-sync-persisted", fingerprint, network, scope] as const,
};

export type WalletSyncResult = { snapshot: WalletSyncSnapshot; syncError?: string };

export function useDeploymentWalletSync(deployment: Deployment | null | undefined, fingerprint?: string) {
  const enabled = Boolean(deployment && fingerprint);
  const network = deployment?.network ?? "liquid-testnet";
  const scope = deployment?.deploymentId ?? "none";
  const persisted = useQuery({
    queryKey: walletSyncQueryKeys.persisted(fingerprint ?? "disconnected", network, scope),
    enabled,
    queryFn: () => loadWalletSyncSnapshot(fingerprint!, network, scope),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useQuery({
    queryKey: walletSyncQueryKeys.snapshot(fingerprint ?? "disconnected", network, scope),
    enabled: enabled && persisted.isFetched,
    queryFn: ({ signal }) => refreshDeploymentWallet(deployment!, fingerprint!, signal),
    placeholderData: persisted.data ? { snapshot: persisted.data } : undefined,
    refetchInterval: refetchInterval,
    refetchOnWindowFocus: true,
  });
}

export function useBaseWalletSync(input: {
  fingerprint?: string;
  network?: SignerNetwork;
  enabled?: boolean;
}) {
  const enabled = Boolean(input.enabled !== false && input.fingerprint && input.network);
  const fingerprint = input.fingerprint ?? "disconnected";
  const network = input.network ?? "liquid-testnet";
  const persisted = useQuery({
    queryKey: walletSyncQueryKeys.persisted(fingerprint, network, "base"),
    enabled,
    queryFn: () => loadWalletSyncSnapshot(fingerprint, network, "base"),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useQuery({
    queryKey: walletSyncQueryKeys.snapshot(fingerprint, network, "base"),
    enabled: enabled && persisted.isFetched,
    queryFn: ({ signal }) => refreshBaseWallet({
      fingerprint,
      network,
    }, signal),
    placeholderData: persisted.data ? { snapshot: persisted.data } : undefined,
    refetchInterval: refetchInterval,
    refetchOnWindowFocus: true,
  });
}

export async function refreshDeploymentWallet(
  deployment: Deployment,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<WalletSyncResult> {
  const previous = await loadWalletSyncSnapshot(fingerprint, deployment.network, deployment.deploymentId);
  try {
    return { snapshot: await synchronizeDeploymentWallet(deployment, fingerprint, { signal }) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (!previous) throw error;
    return { snapshot: previous, syncError: error instanceof Error ? error.message : String(error) };
  }
}

export async function refreshBaseWallet(input: {
  fingerprint: string;
  network: SignerNetwork;
}, signal?: AbortSignal): Promise<WalletSyncResult> {
  const previous = await loadWalletSyncSnapshot(input.fingerprint, input.network, "base");
  try {
    return { snapshot: await synchronizeBaseWallet({ ...input, signal }) };
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
