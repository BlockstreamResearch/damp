import { afterEach, describe, expect, it, vi } from "vitest";
import { auditProgressMessage, buildAuditReport, reportEndpoint } from "./audit-report-job";

const url = new URL("http://127.0.0.1:43210/report");
const response = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });

describe("audit report jobs", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("rejects remote and credential-bearing URLs before a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const value of ["https://example.com/report", "http://user:secret@127.0.0.1/report", "http://127.0.0.1/report?token=secret", "not a url"])
      expect(() => reportEndpoint(value)).toThrow("Use a report endpoint");
    await expect(buildAuditReport({ url: new URL("https://example.com/report"), token: "token", request: {}, signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow("Use a report endpoint");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes authentication, absent API and unreachable service without echoing responses", async () => {
    for (const [status, message] of [[401, "Authentication failed"], [403, "Authentication failed"], [404, "Report API unavailable"]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status, { error: "sensitive response" })));
      await expect(buildAuditReport({ url, token: "private-token", request: {}, signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow(message);
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("private failure")));
    await expect(buildAuditReport({ url, token: "private-token", request: {}, signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow("Service unreachable or browser connection blocked");
  });

  it("does not equate a running service or missing txindex with readiness", () => {
    expect(auditProgressMessage({ jobId: "job", phase: "starting" })).toContain("readiness is not yet established");
    expect(auditProgressMessage({ jobId: "job", phase: "node-catching-up", transactionIndexEnabled: false })).toContain("enable txindex");
    expect(auditProgressMessage({ jobId: "job", phase: "index-ready", throughHeight: 9 })).toContain("Building report");
  });

  it("advances bounded work and returns the unchanged signed envelope", async () => {
    const signed = { reportJson: "exact bytes", signature: { signature: "signature" } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(202, { jobId: "job", phase: "starting" }))
      .mockResolvedValueOnce(response(202, { jobId: "job", phase: "index-catching-up", height: 300, throughHeight: 900 }))
      .mockResolvedValueOnce(response(200, signed));
    vi.stubGlobal("fetch", fetcher);
    const onProgress = vi.fn();
    const result = await buildAuditReport({ url, token: "private-token", request: { deployment: "fixture" }, signal: new AbortController().signal, onProgress });
    expect(result).toBe(signed);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: "advance", jobId: "job" });
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  });

  it("sends cancellation even after aborting the work request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(202, { jobId: "job", phase: "starting" }))
      .mockImplementationOnce(() => { controller.abort(); throw new DOMException("Aborted", "AbortError"); })
      .mockResolvedValueOnce(response(200, { phase: "cancelled" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(buildAuditReport({ url, token: "token", request: {}, signal: controller.signal, onProgress: vi.fn() })).rejects.toThrow("Aborted");
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ action: "cancel", jobId: "job" });
    expect(fetcher.mock.calls[2][1].signal.aborted).toBe(false);
  });

  it("allows a slow native advance to finish without cancelling its recovery work", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(202, { jobId: "job", phase: "starting" }))
      .mockImplementationOnce((_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        setTimeout(() => resolve(response(200, { reportJson: "slow recovery completed" })), 181000);
      }));
    vi.stubGlobal("fetch", fetcher);
    const pending = buildAuditReport({ url, token: "token", request: {}, signal: controller.signal, onProgress: vi.fn() });
    await vi.advanceTimersByTimeAsync(120001);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].signal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(61249);
    await expect(pending).resolves.toEqual({ reportJson: "slow recovery completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows node and index catch-up separately and throttles node polling", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(202, { jobId: "job", phase: "node-catching-up", blocks: 10, headers: 100 }))
      .mockResolvedValueOnce(response(200, { reportJson: "done" }));
    vi.stubGlobal("fetch", fetcher);
    const pending = buildAuditReport({ url, token: "token", request: {}, signal: new AbortController().signal, onProgress: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auditProgressMessage({ jobId: "job", phase: "node-catching-up", blocks: 10, headers: 100 })).toContain("Node catching up");
    expect(auditProgressMessage({ jobId: "job", phase: "index-catching-up", height: 300, throughHeight: 900 })).toContain("block 300 of 900");
  });

  it("propagates unavailable-history errors without presenting a result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(422, { error: "archival history unavailable" })));
    await expect(buildAuditReport({ url, token: "token", request: {}, signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow("archival history unavailable");
  });
});
