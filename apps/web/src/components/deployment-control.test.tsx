import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeploymentControl } from "./deployment-control";

afterEach(cleanup);

const first = { deploymentId: "11".repeat(32), asset: { ticker: "VERYLONGTICKER", name: "A deliberately long deployment name" } };
const second = { deploymentId: "22".repeat(32), asset: { ticker: "TWO", name: "Second" } };

describe("active deployment control", () => {
  it("renders one deployment as a non-interactive summary", () => {
    render(<DeploymentControl deployments={[first]} activeId={first.deploymentId} onSelect={vi.fn()} />);
    expect(screen.getByLabelText("Active deployment")).toHaveClass("deployment-current");
    expect(screen.queryByRole("combobox", { name: "Active deployment" })).not.toBeInTheDocument();
    expect(screen.getByText(/VERYLONGTICKER/)).toHaveAttribute("title", expect.stringContaining(first.deploymentId));
  });

  it("keeps an accessible native selector when multiple deployments exist", () => {
    const onSelect = vi.fn();
    render(<DeploymentControl deployments={[first, second]} activeId={first.deploymentId} onSelect={onSelect} />);
    const select = screen.getByRole("combobox", { name: "Active deployment" });
    expect(select).toHaveAttribute("title", expect.stringContaining(first.deploymentId));
    select.focus();
    expect(select).toHaveFocus();
    fireEvent.keyDown(select, { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: second.deploymentId } });
    expect(onSelect).toHaveBeenCalledWith(second.deploymentId);
  });
});
