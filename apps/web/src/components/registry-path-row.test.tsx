import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RegistryPathRow } from "./registry-path-row";

describe("RegistryPathRow", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("renders and copies the exact canonical destination path", async () => {
    const path = `policies/${"ab".repeat(32)}/${"cd".repeat(32)}.json`;
    render(<RegistryPathRow label="Initial D4 policy" path={path} />);

    expect(screen.getByText(path)).toHaveTextContent(path);
    expect(screen.queryByText(/…/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy destination path for Initial D4 policy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
    expect(await screen.findByText("Path copied")).toBeInTheDocument();
  });

  it("reports clipboard failures without altering the value", async () => {
    const notice = vi.fn();
    const path = `deployments/${"ef".repeat(32)}.json`;
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<RegistryPathRow label="Deployment manifest" path={path} onNotice={notice} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy destination path for Deployment manifest" }));
    expect(await screen.findByText("Copy failed")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(path);
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });
});
