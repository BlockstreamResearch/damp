const pendingOperations = new Set<string>();

export function setSignerOperationPending(key: string, pending: boolean) {
  if (pending) pendingOperations.add(key);
  else pendingOperations.delete(key);
}

export function hasPendingSignerOperation() {
  return pendingOperations.size > 0;
}

export function clearSignerOperationState() {
  pendingOperations.clear();
}
