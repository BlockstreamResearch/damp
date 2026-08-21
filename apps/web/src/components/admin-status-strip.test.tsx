import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AdminStatusStrip } from "./admin-status-strip";

afterEach(cleanup);

describe("AdminStatusStrip", () => {
  it("keeps long deployment and anchor values complete and title-accessible", () => {
    const deploymentName = "A deliberately long regulated-asset deployment name for compact layouts";
    const txid = "ab".repeat(32);
    render(<AdminStatusStrip deploymentName={deploymentName} liveAnchorTxid={txid} treeDepth={6} confirmations={138} />);

    const strip = screen.getByRole("region", { name: "Active deployment status" });
    expect(strip).toHaveTextContent("Deployment");
    expect(screen.getByText(deploymentName)).toHaveAttribute("title", deploymentName);
    expect(screen.getByText(txid)).toHaveAttribute("title", txid);
    expect(screen.getByText("D6 / 64")).toBeInTheDocument();
    expect(screen.getByText("138 confirmations")).toHaveClass("good");
  });

  it("uses truthful unresolved states without collapsing labels and values", () => {
    render(<AdminStatusStrip deploymentName="RWA-TEST-1" confirmations={0} />);
    expect(screen.getByText("RWA-TEST-1")).toHaveAttribute("title", "RWA-TEST-1");
    expect(screen.getByText("Resolving…")).toBeInTheDocument();
    expect(screen.getByText("Not resolved")).toBeInTheDocument();
    expect(screen.getByText("0 confirmations")).toHaveClass("warn");
  });
});
