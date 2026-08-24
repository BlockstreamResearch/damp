import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { validateDeployment } from "./amp-signer";
import { publicManifest, type Deployment } from "./domain";
import { canonicalRegistryContent, fetchCanonicalDeploymentCatalog, type CanonicalDeployment } from "./github";
import { getActiveDeploymentId, listDeployments, setActiveDeploymentId } from "./store";

export const deploymentQueryKeys = {
  all: ["deployments"] as const,
  state: ["deployments", "authoritative-state"] as const,
  activeId: ["deployments", "authoritative-state"] as const,
  active: ["deployments", "authoritative-state"] as const,
};

export type DeploymentState = {
  deployments: Deployment[];
  activeId: string | null;
  active: Deployment | null;
};

export type DeploymentStateDependencies = {
  catalog: () => Promise<CanonicalDeployment[]>;
  local: () => Promise<Deployment[]>;
  activeId: () => Promise<string | null>;
  select: (deploymentId: string) => Promise<void>;
  validate: (manifest: CanonicalDeployment["manifest"]) => Promise<string>;
};

const defaultDependencies: DeploymentStateDependencies = {
  catalog: fetchCanonicalDeploymentCatalog,
  local: listDeployments,
  activeId: getActiveDeploymentId,
  select: setActiveDeploymentId,
  validate: validateDeployment,
};

/**
 * Reconcile persisted working state against the canonical registry catalog.
 * Published records absent from (or byte-different to) the default branch are
 * stale caches and never remain selectable. Local/pending issuer work remains
 * available until it is published.
 */
export async function loadDeploymentState(
  dependencies: Partial<DeploymentStateDependencies> = {},
): Promise<DeploymentState> {
  const deps = { ...defaultDependencies, ...dependencies };
  const [catalog, local, storedActiveId] = await Promise.all([
    deps.catalog(),
    deps.local(),
    deps.activeId(),
  ]);
  const canonical = new Map<string, CanonicalDeployment>();
  for (const entry of catalog) {
    const derivedId = await deps.validate(entry.manifest);
    if (derivedId !== entry.deploymentId) {
      throw new Error(`Canonical deployment filename does not match manifest ${entry.deploymentId}.`);
    }
    if (canonical.has(entry.deploymentId)) throw new Error("Canonical deployment catalog contains a duplicate ID.");
    canonical.set(entry.deploymentId, entry);
  }

  const deployments = local.filter((deployment) => {
    if (deployment.publication !== "published") return true;
    const entry = canonical.get(deployment.deploymentId);
    return entry !== undefined
      && canonicalRegistryContent(publicManifest(deployment)) === canonicalRegistryContent(entry.manifest);
  }).sort((left, right) => {
    const leftCanonical = canonical.has(left.deploymentId) ? 0 : 1;
    const rightCanonical = canonical.has(right.deploymentId) ? 0 : 1;
    return leftCanonical - rightCanonical || left.asset.ticker.localeCompare(right.asset.ticker)
      || left.deploymentId.localeCompare(right.deploymentId);
  });

  const active = deployments.find((deployment) => deployment.deploymentId === storedActiveId)
    ?? deployments[0]
    ?? null;
  if (active && active.deploymentId !== storedActiveId) await deps.select(active.deploymentId);
  return { deployments, activeId: active?.deploymentId ?? null, active };
}

export function useDeployments() {
  return useQuery({
    queryKey: deploymentQueryKeys.state,
    queryFn: () => loadDeploymentState(),
    select: (state) => state.deployments,
    staleTime: 60_000,
  });
}

export function useActiveDeployment() {
  return useQuery({
    queryKey: deploymentQueryKeys.state,
    queryFn: () => loadDeploymentState(),
    select: (state) => state.active,
    staleTime: 60_000,
  });
}

export function useActiveDeploymentId() {
  return useQuery({
    queryKey: deploymentQueryKeys.state,
    queryFn: () => loadDeploymentState(),
    select: (state) => state.activeId,
    staleTime: 60_000,
  });
}

export function useSelectDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setActiveDeploymentId,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: ["anchor"] }),
        queryClient.invalidateQueries({ queryKey: ["wallet-sync"] }),
        queryClient.invalidateQueries({ queryKey: ["policy"] }),
      ]);
    },
  });
}
