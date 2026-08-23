import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopyableAddress } from "./copyable-address";

const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CopyableAddress", () => {
  it("displays a compact address but copies the full canonical value", async () => {
    const address = `tlq1${"q".repeat(72)}`;
    writeText.mockResolvedValue();
    render(<CopyableAddress address={address} resetKey="profile-a:0:7" accessibleLabel="Copy receive address" />);

    expect(screen.getByTitle(address)).not.toHaveTextContent(address);
    fireEvent.click(screen.getByRole("button", { name: "Copy receive address" }));
    await act(async () => undefined);

    expect(writeText).toHaveBeenCalledWith(address);
    expect(screen.getByRole("button", { name: "Copy receive address: copied" })).toBeInTheDocument();
  });

  it("resets temporary copied feedback and reports clipboard failure honestly", async () => {
    vi.useFakeTimers();
    writeText.mockResolvedValueOnce().mockRejectedValueOnce(new Error("permission denied"));
    const onNotice = vi.fn();
    render(<CopyableAddress address={`tlq1${"a".repeat(60)}`} accessibleLabel="Copy wallet address" onNotice={onNotice} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy wallet address" }));
    await act(async () => undefined);
    expect(screen.getByText("Copied")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_500));
    expect(screen.getByText("Copy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy wallet address" }));
    await act(async () => undefined);
    expect(screen.getByText("Copy failed")).toBeInTheDocument();
    expect(onNotice).toHaveBeenLastCalledWith({ tone: "error", message: "Could not copy: permission denied" });
  });

  it("cancels stale copy completion when the active profile or address changes", async () => {
    const oldAddress = `tlq1${"b".repeat(60)}`;
    const nextAddress = `tlq1${"c".repeat(60)}`;
    let finishOld: (() => void) | undefined;
    writeText
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce();

    const { rerender } = render(<CopyableAddress address={oldAddress} resetKey="profile-a:0:1" accessibleLabel="Copy receive address" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy receive address" }));
    expect(screen.getByText("Copying…")).toBeInTheDocument();

    rerender(<CopyableAddress address={nextAddress} resetKey="profile-b:0:0" accessibleLabel="Copy receive address" />);
    expect(screen.getByText("Copy")).toBeInTheDocument();
    await act(async () => finishOld?.());
    expect(screen.getByText("Copy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy receive address" }));
    await act(async () => undefined);
    expect(writeText).toHaveBeenNthCalledWith(1, oldAddress);
    expect(writeText).toHaveBeenNthCalledWith(2, nextAddress);
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });
});
