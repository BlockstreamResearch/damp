import { afterEach, describe, expect, it, vi } from "vitest";
import { auditProgressMessage, buildAuditReport } from "./audit-report-job";

const url = new URL("http://127.0.0.1:43210/report");
const response = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });

describe("audit report jobs", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
