import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlacklistTable } from "./blacklist-table";

const entry = { txid: "ab".repeat(32), vout: 3, note: "Compliance case" };

afterEach(cleanup);

describe("blacklist table semantics", () => {
  it("uses native table structure with mobile labels and an accessible action", () => {
    const onRemove = vi.fn();
    const { container } = render(<BlacklistTable entries={[entry]} activeOutpoints={new Set([`${entry.txid}:${entry.vout}`])} onRemove={onRemove} />);

    expect(screen.getByRole("table", { name: "Exact outpoints in the active blacklist draft" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(container.querySelector('td[data-label="Outpoint"]')).toBeInTheDocument();
    expect(container.querySelector('td[data-label="Note"]')).toHaveTextContent("Compliance case");
    expect(screen.getByText("Active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Remove outpoint/ }));
    expect(onRemove).toHaveBeenCalledWith(entry);
  });

  it("renders disabled removal coherently and keeps a valid empty row", () => {
    const { rerender } = render(<BlacklistTable entries={[entry]} activeOutpoints={new Set()} disabled onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Remove outpoint/ })).toBeDisabled();

    rerender(<BlacklistTable entries={[]} activeOutpoints={new Set()} onRemove={vi.fn()} />);
    expect(screen.getByRole("cell", { name: /Empty blacklist/ })).toHaveAttribute("colspan", "4");
  });
});
