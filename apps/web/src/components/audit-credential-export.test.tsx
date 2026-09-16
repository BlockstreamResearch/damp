import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentFixture } from "../test/fixtures";
const mocks = vi.hoisted(() => ({
  state: { connected: true, network: "liquid-testnet", profiles: [], walletReady: false },
  revision: 1, derive: vi.fn(), discover: vi.fn(), export: vi.fn(), download: vi.fn(),
}));
vi.mock("../lib/damp-signer", () => ({
  signerSnapshot: () => mocks.state, subscribeSigner: () => () => {},
  signerSessionRevision: () => mocks.revision, deriveDampKey: mocks.derive, exportAuditCredentials: mocks.export,
}));
vi.mock("../lib/audit-issuer-history", () => ({ discoverIssuerTransactions: mocks.discover }));
vi.mock("../lib/download-json", () => ({ downloadBlob: mocks.download }));
import { AuditCredentialExport } from "./audit-credential-export";
const deployment = deploymentFixture();
function open() { render(<AuditCredentialExport deployment={deployment} />); fireEvent.click(screen.getByText("Export issuer audit credentials")); }
describe("issuer credential export", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.state.connected = true; mocks.state.network = deployment.network; mocks.revision = 1;
    localStorage.setItem("simplicity-damp:regtest-esplora", "http://127.0.0.1:3002/api");
    mocks.derive.mockResolvedValue({ publicKey: deployment.issuerPublicKey });
    mocks.discover.mockResolvedValue(["aa"]); mocks.export.mockReturnValue("restricted-file");
  });
  afterEach(cleanup);
  it("explains the disconnected state and does not fetch public data", () => {
    mocks.state.connected = false; open();
    expect(screen.getByRole("button", { name: "Discover and download credentials" })).toBeDisabled();
    expect(screen.getByText(/Connect the issuer signer above to enable export/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect issuer signer" })).toBeEnabled();
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it("rejects the wrong issuer before querying a provider", async () => {
    mocks.derive.mockResolvedValue({ publicKey: "wrong" }); open();
    fireEvent.click(screen.getByRole("button", { name: "Discover and download credentials" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This signer is not the deployment's issuer");
    expect(mocks.discover).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it("withholds credentials when the signer changes during discovery", async () => {
    mocks.discover.mockImplementation(async () => { mocks.revision++; return ["aa"]; }); open();
    fireEvent.click(screen.getByRole("button", { name: "Discover and download credentials" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("signer changed");
    expect(mocks.export).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
  it("exports only after successful public discovery and local issuer checks", async () => {
    open(); fireEvent.click(screen.getByRole("button", { name: "Discover and download credentials" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith("restricted-file", "audit-credentials.json"));
    expect(mocks.export).toHaveBeenCalledWith(deployment, ["aa"]);
  });
});
