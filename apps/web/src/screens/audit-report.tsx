import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell, Panel, Pill, SectionHeading } from "../components/ui";
import { useActiveDeployment } from "../lib/deployments";
import {
  publicManifest,
  shortHash,
  userFacingError,
  formatUnits,
} from "../lib/domain";
import { getDraft, listDeploymentPolicies, putDraft } from "../lib/store";
import { blacklistDraftName } from "../lib/blacklist-drafts";
import { signerSnapshot, verifyAuditReport } from "../lib/damp-signer";
import { updateHolderBlacklistDraft } from "../lib/holder-blacklist-draft";
import { resolvePolicyHistory } from "../lib/policy-registry";
import { downloadJson } from "../lib/download-json";
import {
  auditProgressMessage,
  buildAuditReport,
} from "../lib/audit-report-job";
import type { BlacklistEntry, PolicySnapshot } from "../lib/domain";

const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .nullable();
const outputSchema = z.object({
  outpoint: z.string().regex(/^[0-9a-f]{64}:\d+$/),
  amount,
  recoveryStatus: z.string(),
  auxiliaryStatus: z.string(),
  applicationBounds: z.string(),
  spent: z.boolean(),
  blocked: z.boolean(),
  blockEligible: z.boolean(),
});
const reportSchema = z.object({
  schema: z.literal("damp-audit-report/v2"),
  deploymentId: z.string(),
  network: z.string(),
  complete: z.boolean(),
  throughHeight: z.number().int(),
  minimumConfirmations: z.number().int(),
  anchor: z.string(),
  policyRoot: z.string().nullable(),
  tip: z.object({ height: z.number().int(), hash: z.string() }),
  supply: z.object({
    issued: amount,
    knownUnspent: amount,
    burned: amount,
    unresolvedOutputs: z.number().int(),
    conservation: z.string(),
  }),
  outputs: z.array(outputSchema),
  gaps: z.array(z.object({ type: z.string() }).passthrough()),
  limits: z.array(z.string()),
});
type Report = z.infer<typeof reportSchema>;
type SignedReport = {
  reportJson: string;
  signature: {
    signature: string;
    publicKey: string;
    algorithm: string;
    certificateJson: string;
    certificateSignature: string;
  };
};

export function AuditReport() {
  const active = useActiveDeployment();
  const deployment = active.data;
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report>();
  const [signed, setSigned] = useState<SignedReport>();
  const [message, setMessage] = useState("");
  const [fallback, setFallback] = useState(false);
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    generation.current += 1;
    request.current?.abort();
    setReport(undefined);
    setSigned(undefined);
    setMessage("");
    setBusy(false);
    return () => {
      request.current?.abort();
    };
  }, [deployment?.deploymentId]);
  async function generate() {
    if (!deployment) return;
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage("");
    setReport(undefined);
    setSigned(undefined);
    try {
      if (!endpoint.trim()) throw new Error("Enter a report endpoint.");
      const url = new URL(endpoint.trim());
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/report" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Use a report endpoint at http://127.0.0.1:PORT/report.",
        );
      const storedPolicies = await listDeploymentPolicies(
        deployment.deploymentId,
      );
      if (!storedPolicies.length)
        throw new Error(
          "Import the deployment's current policy before scanning.",
        );
      const latest = storedPolicies.reduce((candidate, policy) =>
        policy.sequence > candidate.sequence ? policy : candidate,
      );
      const policies = await resolvePolicyHistory(deployment, latest);
      controller.signal.throwIfAborted();
      const result = await buildAuditReport<SignedReport>({
        url,
        token,
        request: {
          deployment: publicManifest(deployment),
          policies,
          confirmations: 2,
          dlpUpperBound: fallback ? 1048576 : 0,
        },
        signal: controller.signal,
        onProgress: (progress) => {
          if (current === generation.current)
            setMessage(auditProgressMessage(progress));
        },
      });
      const certificateJson = result.signature.certificateJson;
      if (!certificateJson || !result.signature.certificateSignature)
        throw new Error("An issuer-certified report key is required.");
      await verifyAuditReport(
        certificateJson,
        result.signature.certificateSignature,
        deployment.issuerPublicKey,
      );
      const certificate = z
        .object({
          schema: z.literal("damp-audit-report-authorization/v1"),
          deploymentId: z.string(),
          network: z.string(),
          reportPublicKey: z.string(),
          issuerPublicKey: z.string(),
          auditPublicKey: z.string(),
        })
        .parse(JSON.parse(certificateJson));
      if (
        certificate.deploymentId !== deployment.deploymentId ||
        certificate.network !== deployment.network ||
        certificate.issuerPublicKey !== deployment.issuerPublicKey ||
        certificate.auditPublicKey !== deployment.audit.publicKey ||
        certificate.reportPublicKey !== result.signature.publicKey
      )
        throw new Error(
          "Report key authorization belongs to another deployment.",
        );
      await verifyAuditReport(
        result.reportJson,
        result.signature.signature,
        certificate.reportPublicKey,
      );
      const parsed = reportSchema.parse(JSON.parse(result.reportJson));
      if (
        parsed.deploymentId !== deployment.deploymentId ||
        parsed.network !== deployment.network
      )
        throw new Error("Report belongs to another deployment.");
      if (current !== generation.current) return;
      setReport(parsed);
      setSigned(result);
      setMessage("Report ready. Certificate and report signatures verified.");
    } catch (error) {
      if (current === generation.current)
        setMessage(
          controller.signal.aborted
            ? "Report cancelled. Committed public history is retained; confidential recovery restarts next time."
            : userFacingError(error),
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function download() {
    if (!signed || !deployment) return;
    downloadJson(
      signed,
      `damp-report-${deployment.deploymentId.slice(0, 12)}.json`,
    );
  }
  async function draftBlock(row: Report["outputs"][number]) {
    if (!deployment || !report || !row.blockEligible) return;
    try {
      const policies = await listDeploymentPolicies(deployment.deploymentId);
      const policy: PolicySnapshot | undefined = policies.find(
        (p) => p.policyRoot === report.policyRoot,
      );
      const profile = signerSnapshot().profileId;
      if (!profile || !policy)
        throw new Error(
          "Connect the issuer signer and load the current policy before drafting a block.",
        );
      const name = blacklistDraftName(policy.policyRoot, profile);
      const stored = await getDraft<BlacklistEntry[]>(
        deployment.deploymentId,
        name,
      );
      const [txid, vout] = row.outpoint.split(":");
      const next = updateHolderBlacklistDraft({
        activeDeploymentId: deployment.deploymentId,
        rowDeploymentId: report.deploymentId,
        draft: stored ?? policy.entries,
        active: policy.entries,
        txid,
        vout: Number(vout),
        status: row.spent ? "spent" : "confirmed",
        action: "add",
      });
      await putDraft(deployment.deploymentId, name, next);
      setMessage(
        "Output added to the blacklist draft. Review it in Blacklist before signing a policy change.",
      );
    } catch (error) {
      setMessage(userFacingError(error));
    }
  }
  return (
    <AppShell
      eyebrow="Issuer Console / Report"
      title="Auditable transfer report"
    >
      <Panel className="audit-report-panel">
        <SectionHeading
          label="Native confidential audit"
          title="Recover and reconcile"
        />
        {active.error ? (
          <p role="alert">{userFacingError(active.error)}</p>
        ) : active.isPending ? (
          <p>Loading deployments…</p>
        ) : !deployment ? (
          <p>Select a deployment to build a report.</p>
        ) : (
          <>
            <p>
              Enter an issuer-operated report endpoint to scan confirmed
              transactions, recover amounts, and check supply. This application
              verifies signed reports but does not include a report server.
              Only loopback HTTP endpoints are accepted. The endpoint needs
              scoped audit and report keys, never spending keys. Transfers
              proceed independently of reporting.
            </p>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void generate();
              }}
            >
              <label>
                Report endpoint
                <input
                  type="url"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  autoComplete="off"
                  placeholder="http://127.0.0.1:PORT/report"
                  required
                />
              </label>
              <label>
                Access token
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="audit-report-option">
                <input
                  type="checkbox"
                  checked={fallback}
                  onChange={(e) => setFallback(e.target.checked)}
                />{" "}
                Try bounded recovery for missing or invalid data, up to
                1,048,576 base units
              </label>
              <button
                className="button issuer-primary"
                disabled={busy || !endpoint.trim() || !token}
                aria-busy={busy}
              >
                {busy
                  ? "Scanning confirmed history…"
                  : "Generate signed report"}
              </button>
              {busy ? (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => request.current?.abort()}
                >
                  Cancel report
                </button>
              ) : null}
            </form>
            <p>
              The service indexes all retained blocks from bootstrap through a
              fixed confirmed snapshot in resumable batches. Node sync, index
              progress, and report recovery are separate steps. Missing history
              or resource limits prevent a complete report; they do not
              establish a recovery-data failure.
            </p>
          </>
        )}
        {message ? (
          <p role="status" className="inline-message">
            {message}
          </p>
        ) : null}
        {report && deployment ? (
          <section aria-label="Verified issuer report">
            <SectionHeading
              label={`Through block ${report.throughHeight}`}
              title={
                report.complete ? "Supply reconciled" : "Report needs attention"
              }
              aside={
                <Pill tone={report.complete ? "good" : "warn"}>
                  {report.complete ? "Complete snapshot" : "Incomplete"}
                </Pill>
              }
            />
            <dl className="review-stack">
              <div className="review-row">
                <dt>Issued</dt>
                <dd>
                  {report.supply.issued === null
                    ? "Unknown"
                    : formatUnits(
                        report.supply.issued,
                        deployment.asset.precision,
                      )}
                </dd>
              </div>
              <div className="review-row">
                <dt>Known unspent</dt>
                <dd>
                  {report.supply.knownUnspent === null
                    ? "Unknown"
                    : formatUnits(
                        report.supply.knownUnspent,
                        deployment.asset.precision,
                      )}
                </dd>
              </div>
              <div className="review-row">
                <dt>Unresolved outputs</dt>
                <dd>{report.supply.unresolvedOutputs}</dd>
              </div>
              <div className="review-row">
                <dt>Conservation</dt>
                <dd>{report.supply.conservation}</dd>
              </div>
            </dl>
            {report.gaps.length ? (
              <ul>
                {report.gaps.map((gap, i) => (
                  <li key={i}>{gap.type}</li>
                ))}
              </ul>
            ) : null}
            <div className="blacklist-table">
              <table>
                <caption>Confirmed regulated outputs</caption>
                <thead>
                  <tr>
                    <th>Output</th>
                    <th>Amount</th>
                    <th>Recovery</th>
                    <th>State</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {report.outputs.map((row) => (
                    <tr key={row.outpoint}>
                      <td>
                        <code title={row.outpoint}>
                          {shortHash(row.outpoint, 10, 6)}
                        </code>
                      </td>
                      <td>
                        {row.amount === null
                          ? "Unknown"
                          : formatUnits(row.amount, deployment.asset.precision)}
                        {row.applicationBounds === "outside-application-cap" ? (
                          <small> Outside application cap</small>
                        ) : null}
                      </td>
                      <td>
                        {row.recoveryStatus}
                        <small> Auxiliary: {row.auxiliaryStatus}</small>
                      </td>
                      <td>
                        {row.spent
                          ? "Spent"
                          : row.blocked
                            ? "Blocked"
                            : "Unspent"}
                      </td>
                      <td>
                        {row.blockEligible ? (
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => void draftBlock(row)}
                          >
                            Draft output block
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Recovery-data failures describe submitted bytes. They do not
              identify intent or blame the recipient. A drafted block affects
              only the selected output's future spend after a policy update.
            </p>
            <button
              className="button secondary"
              type="button"
              onClick={download}
            >
              Download signed JSON
            </button>{" "}
            <Link to="/admin/blacklist">Review blacklist draft</Link>
            <details>
              <summary>Coverage and issuer authority</summary>
              <ul>
                {report.limits.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}
      </Panel>
    </AppShell>
  );
}
