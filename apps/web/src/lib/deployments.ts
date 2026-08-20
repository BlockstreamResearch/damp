import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getActiveDeployment, getActiveDeploymentId, listDeployments, setActiveDeploymentId } from "./store";

export const deploymentQueryKeys = {
  all: ["deployments"] as const,
  activeId: ["deployments", "active-id"] as const,
  active: ["deployments", "active"] as const,
};

export function useDeployments() {
  return useQuery({ queryKey: deploymentQueryKeys.all, queryFn: listDeployments });
}

export function useActiveDeployment() {
  return useQuery({ queryKey: deploymentQueryKeys.active, queryFn: getActiveDeployment });
}

export function useActiveDeploymentId() {
  return useQuery({ queryKey: deploymentQueryKeys.activeId, queryFn: getActiveDeploymentId });
}

export function useSelectDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setActiveDeploymentId,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.activeId }),
        queryClient.invalidateQueries({ queryKey: deploymentQueryKeys.active }),
        queryClient.invalidateQueries({ queryKey: ["anchor"] }),
        queryClient.invalidateQueries({ queryKey: ["wallet-sync"] }),
        queryClient.invalidateQueries({ queryKey: ["policy"] }),
      ]);
    },
  });
}
