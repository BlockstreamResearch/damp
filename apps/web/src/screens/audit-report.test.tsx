import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentFixture } from "../test/fixtures";
import type { PolicySnapshot } from "../lib/domain";

const mocks = vi.hoisted(() => ({
  active: vi.fn(), policies: vi.fn(), history: vi.fn(), build: vi.fn(), verify: vi.fn(),
}));
vi.mock("../lib/deployments", () => ({ useActiveDeployment: mocks.active }));
vi.mock("../lib/store", () => ({ listDeploymentPolicies: mocks.policies, getDraft: vi.fn(), putDraft: vi.fn() }));
vi.mock("../lib/policy-registry", () => ({ resolvePolicyHistory: mocks.history }));
vi.mock("../lib/audit-report-job", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/audit-report-job")>(),
  buildAuditReport: mocks.build,
}));
vi.mock("../lib/damp-signer", () => ({ verifyAuditReport: mocks.verify, signerSnapshot: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock("../components/ui", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pill: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SectionHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

import { AuditReport } from "./audit-report";

const deployment = deploymentFixture();
const latest = { sequence: 9 } as PolicySnapshot;

async function startReport() {
  render(<AuditReport />);
  fireEvent.change(screen.getByLabelText("Report endpoint"), { target: { value: "http://127.0.0.1:43210/report" } });
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "test-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Generate signed report" }));
  await waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
}

describe("audit report interaction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.active.mockReturnValue({ data: deployment, isPending: false });
    mocks.policies.mockResolvedValue([{ sequence: 2 }, latest, { sequence: 4 }]);
    mocks.history.mockResolvedValue([latest]);
  });
  afterEach(cleanup);

  it("requires an explicit endpoint and token without contacting a default server", () => {
    render(<AuditReport />);
    expect(screen.getByLabelText("Report endpoint")).toHaveValue("");
    const generate = screen.getByRole("button", { name: "Generate signed report" });
    expect(generate).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "test-token" } });
    expect(generate).toBeDisabled();
    fireEvent.click(generate);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.policies).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Report endpoint"), { target: { value: "http://127.0.0.1:43210/report" } });
    expect(generate).toBeEnabled();
  });

  it("rejects non-loopback endpoints before sending credentials or requesting policies", async () => {
    render(<AuditReport />);
    fireEvent.change(screen.getByLabelText("Report endpoint"), { target: { value: "https://reports.example.com/report" } });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate signed report" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Use a report endpoint at http://127.0.0.1:PORT/report.");
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.policies).not.toHaveBeenCalled();
  });

  it("uses the highest-sequence policy and displays an ordinary service error", async () => {
    mocks.build.mockRejectedValue(new Error("archival history unavailable"));
    await startReport();
    expect(mocks.history).toHaveBeenCalledWith(deployment, latest);
    expect(await screen.findByRole("status")).toHaveTextContent("archival history unavailable");
    expect(screen.queryByRole("button", { name: "Download signed JSON" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate signed report" })).toBeEnabled();
  });

  it("aborts the running request and distinguishes cancellation from failure", async () => {
    mocks.build.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await startReport();
    const signal = mocks.build.mock.calls[0][0].signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel report" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Report cancelled."));
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Generate signed report" })).toBeEnabled();
  });

  it("verifies both signatures before enabling the signed download", async () => {
    const certificateJson = JSON.stringify({
      schema: "damp-audit-report-authorization/v1", deploymentId: deployment.deploymentId,
      network: deployment.network, reportPublicKey: "report-key",
      issuerPublicKey: deployment.issuerPublicKey, auditPublicKey: deployment.audit.publicKey,
    });
    const reportJson = JSON.stringify({
      schema: "damp-audit-report/v2", deploymentId: deployment.deploymentId,
      network: deployment.network, complete: true, throughHeight: 100, minimumConfirmations: 2,
      anchor: "anchor", policyRoot: null, tip: { height: 101, hash: "tip" },
      supply: { issued: "1100", knownUnspent: "1100", burned: "0", unresolvedOutputs: 0, conservation: "1100 = 1100" },
      outputs: [], gaps: [], limits: [],
    });
    mocks.build.mockResolvedValue({ reportJson, signature: {
      certificateJson, certificateSignature: "issuer-signature", publicKey: "report-key", signature: "report-signature",
    } });
    await startReport();
    expect(await screen.findByRole("button", { name: "Download signed JSON" })).toBeEnabled();
    expect(mocks.verify.mock.calls).toEqual([
      [certificateJson, "issuer-signature", deployment.issuerPublicKey],
      [reportJson, "report-signature", "report-key"],
    ]);
    expect(screen.getByText("1100 = 1100")).toBeInTheDocument();
  });
});
