import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BootstrapRegistryState } from "./bootstrap-registry-state";

afterEach(cleanup);

const base = {
  network: "liquid-testnet" as const,
  txid: "11".repeat(32),
  assetId: "22".repeat(32),
  publication: "pending" as const,
  filesReady: false,
  onCheckConfirmation: vi.fn(),
  onPrepareRegistry: vi.fn(),
};

describe("bootstrap registry state", () => {
  it("presents an explicit confirmation check instead of premature preparation", () => {
    const onCheckConfirmation = vi.fn();
    render(<BootstrapRegistryState {...base} confirmations={0} onCheckConfirmation={onCheckConfirmation} />);

    expect(screen.getByText("Pending confirmation check")).toBeInTheDocument();
    expect(screen.getByText("Issued asset").nextElementSibling).toHaveTextContent("222222222222…2222222222");
    expect(screen.getByText("Issuance transaction").nextElementSibling).toHaveTextContent("111111111111…1111111111");
    expect(screen.getByRole("group", { name: "Registry publication actions" })).toHaveClass("bootstrap-registry-actions");
    expect(screen.queryByRole("button", { name: /Prepare confirmed registry files/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Check transaction confirmation/ }));
    expect(onCheckConfirmation).toHaveBeenCalledOnce();
  });

  it("enables file preparation only after confirmation is recorded", () => {
    const onPrepareRegistry = vi.fn();
    render(<BootstrapRegistryState {...base} confirmations={2} onPrepareRegistry={onPrepareRegistry} />);

    expect(screen.getByText("Confirmation verified")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check transaction confirmation/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Prepare confirmed registry files/ }));
    expect(onPrepareRegistry).toHaveBeenCalledOnce();
  });

  it("keeps the confirmation control disabled and truthful while polling", () => {
    render(<BootstrapRegistryState {...base} confirmations={0} busyAction="confirm" />);
    expect(screen.getByRole("button", { name: /Checking confirmation/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Checking confirmation/ })).toHaveAttribute("aria-busy", "true");
  });

  it("uses an external testnet explorer safely and omits it on regtest", () => {
    const { rerender } = render(<BootstrapRegistryState {...base} confirmations={0} />);
    expect(screen.getByRole("link", { name: /View transaction/ })).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    rerender(<BootstrapRegistryState {...base} network="elements-regtest" confirmations={0} />);
    expect(screen.queryByRole("link", { name: /View transaction/ })).not.toBeInTheDocument();
  });
});
