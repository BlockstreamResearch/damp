import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlacklistTable } from "./blacklist-table";

const entry = { txid: "ab".repeat(32), vout: 3, note: "Compliance case" };

afterEach(cleanup);

describe("blacklist table semantics", () => {
  it("uses native table structure with mobile labels and an accessible action", () => {
    const onRemove = vi.fn();
    const { container } = render(<BlacklistTable entries={[entry]} activeEntries={[entry]} onRemove={onRemove} onUndoRemoval={vi.fn()} />);

    expect(screen.getByRole("table", { name: "Exact outpoints in the active blacklist draft" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(container.querySelector('td[data-label="Outpoint"]')).toBeInTheDocument();
    expect(container.querySelector('td[data-label="Note"]')).toHaveTextContent("Compliance case");
    expect(screen.getByText("Blacklisted — cannot be spent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Draft removal of outpoint/ }));
    expect(onRemove).toHaveBeenCalledWith(entry);
  });

  it("keeps active removals visible and lets the issuer undo the draft removal", () => {
    const onUndoRemoval = vi.fn();
    render(<BlacklistTable entries={[]} activeEntries={[entry]} onRemove={vi.fn()} onUndoRemoval={onUndoRemoval} />);

    expect(screen.getByText("Removal drafted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Undo removal of outpoint/ }));
    expect(onUndoRemoval).toHaveBeenCalledWith(entry);
  });

  it("renders disabled removal coherently and keeps a valid empty row", () => {
    const { rerender } = render(<BlacklistTable entries={[entry]} activeEntries={[]} disabled onRemove={vi.fn()} onUndoRemoval={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Draft removal of outpoint/ })).toBeDisabled();

    rerender(<BlacklistTable entries={[]} activeEntries={[]} onRemove={vi.fn()} onUndoRemoval={vi.fn()} />);
    expect(screen.getByRole("cell", { name: /Empty blacklist/ })).toHaveAttribute("colspan", "4");
  });
});
