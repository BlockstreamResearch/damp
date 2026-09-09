import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadJson } from "./download-json";
import { canonicalRegistryContent, downloadCanonicalRegistryFile } from "./github";

describe("downloadJson", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clicks a named JSON download before revoking its blob URL", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    downloadJson({ reportJson: "{}" }, "damp-report.json");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(await (createObjectURL.mock.calls[0][0] as Blob).text()).toBe(JSON.stringify({ reportJson: "{}" }, null, 2));
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.href).toBe("blob:report");
    expect(anchor.download).toBe("damp-report.json");
    expect(document.body.contains(anchor)).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
  });

  it("preserves canonical registry bytes, including the trailing newline", async () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:registry");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const content = { schema: "test", value: 1 };
    expect(downloadCanonicalRegistryFile("deployments/test.json", content)).toEqual({
      filename: "test.json", path: "deployments/test.json",
    });
    expect(await (create.mock.calls[0][0] as Blob).text()).toBe(canonicalRegistryContent(content));
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(revoke).toHaveBeenCalledWith("blob:registry");
  });
});
