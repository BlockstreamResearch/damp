import { afterEach, describe, expect, it } from "vitest";

import { clearSignerOperationState, hasPendingSignerOperation, setSignerOperationPending } from "./signer-operation-state";

afterEach(clearSignerOperationState);

describe("signer operation transition guard", () => {
  it("requires confirmation while any reviewed or signing operation remains pending", () => {
    setSignerOperationPending("transfer", true);
    setSignerOperationPending("reissuance", true);
    expect(hasPendingSignerOperation()).toBe(true);
    setSignerOperationPending("transfer", false);
    expect(hasPendingSignerOperation()).toBe(true);
    setSignerOperationPending("reissuance", false);
    expect(hasPendingSignerOperation()).toBe(false);
  });
});
