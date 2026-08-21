import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SignerProfilePicker } from "./signer-profile-picker";

const profileA = {
  id: `liquid-testnet:${"aa".repeat(32)}`,
  fingerprint: "aabbccdd",
  label: "QA Alice with a deliberately long but recognizable profile name",
  network: "liquid-testnet" as const,
  unlocked: true,
};

const profileB = {
  id: `liquid-testnet:${"bb".repeat(32)}`,
  fingerprint: "11223344",
  label: "Signer 11223344",
  network: "liquid-testnet" as const,
  unlocked: false,
};

afterEach(cleanup);

describe("SignerProfilePicker", () => {
  it("renders one profile as a compact non-interactive identity", () => {
    render(<SignerProfilePicker label="Active signer profile" profiles={[profileB]} selectedId={profileB.id} onSelect={vi.fn()} />);
    expect(screen.getByLabelText("Active signer profile")).toHaveTextContent(/Signer profile.*11223344.*Locked/);
    expect(screen.queryByRole("button", { name: "Active signer profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports arrow navigation, selection, and focus return", async () => {
    const onSelect = vi.fn();
    render(<SignerProfilePicker label="Active signer profile" profiles={[profileA, profileB]} selectedId={profileA.id} onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "Active signer profile" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const alice = await screen.findByRole("option", { name: /QA Alice.*aabbccdd.*Liquid testnet/ });
    const bob = screen.getByRole("option", { name: /Signer profile.*11223344.*Liquid testnet.*Locked/ });
    await waitFor(() => expect(alice).toHaveFocus());
    expect(alice).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(alice, { key: "ArrowDown" });
    expect(bob).toHaveFocus();
    fireEvent.keyDown(bob, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(profileB.id);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses with Escape or an outside pointer interaction", async () => {
    render(<SignerProfilePicker label="Active signer profile" profiles={[profileA, profileB]} selectedId={profileA.id} onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Active signer profile" });
    fireEvent.click(trigger);
    const alice = await screen.findByRole("option", { name: /QA Alice/ });
    fireEvent.keyDown(alice, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps the remembered-profile clear choice explicit", () => {
    const onUseDifferentProfile = vi.fn();
    render(<SignerProfilePicker label="Remembered signer profile" profiles={[profileB]} selectedId={profileB.id} onSelect={vi.fn()} onUseDifferentProfile={onUseDifferentProfile} />);
    fireEvent.click(screen.getByRole("button", { name: "Remembered signer profile" }));
    fireEvent.click(screen.getByRole("option", { name: /Use a different signer phrase/ }));
    expect(onUseDifferentProfile).toHaveBeenCalledOnce();
  });
});
