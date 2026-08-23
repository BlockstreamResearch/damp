import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copying" | "copied" | "failed";

export type ClipboardNotice = { tone: "success" | "error"; message: string };

export function truncateAddress(address: string, start = 14, end = 10) {
  if (address.length <= start + end + 1) return address;
  return `${address.slice(0, start)}…${address.slice(-end)}`;
}

export function ClipboardCopyButton({
  value,
  resetKey,
  accessibleLabel,
  idleLabel = "Copy",
  copiedLabel = "Copied",
  className = "copy-action",
  onNotice,
}: {
  value: string;
  resetKey?: string;
  accessibleLabel: string;
  idleLabel?: string;
  copiedLabel?: string;
  className?: string;
  onNotice?: (notice: ClipboardNotice) => void;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const request = useRef(0);
  const identity = `${resetKey ?? ""}\0${value}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  useEffect(() => {
    request.current += 1;
    setState("idle");
  }, [identity]);

  useEffect(() => {
    if (state !== "copied") return;
    const copiedIdentity = identity;
    const timeout = window.setTimeout(() => {
      if (currentIdentity.current === copiedIdentity) setState("idle");
    }, 2_500);
    return () => window.clearTimeout(timeout);
  }, [identity, state]);

  async function copyValue() {
    const copiedIdentity = identity;
    const copiedValue = value;
    const attempt = ++request.current;
    setState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      await navigator.clipboard.writeText(copiedValue);
      if (request.current !== attempt || currentIdentity.current !== copiedIdentity) return;
      setState("copied");
      onNotice?.({ tone: "success", message: `${accessibleLabel} copied.` });
    } catch (error) {
      if (request.current !== attempt || currentIdentity.current !== copiedIdentity) return;
      setState("failed");
      const detail = error instanceof Error ? error.message : String(error);
      onNotice?.({ tone: "error", message: `Could not copy: ${detail}` });
    }
  }

  const label = state === "copying" ? "Copying…" : state === "copied" ? copiedLabel : state === "failed" ? "Copy failed" : idleLabel;
  return (
    <button
      aria-label={`${accessibleLabel}${state === "copied" ? ": copied" : state === "failed" ? ": copy failed" : ""}`}
      className={`clipboard-copy-button ${className}`.trim()}
      disabled={state === "copying"}
      type="button"
      onClick={() => void copyValue()}
    >
      {state === "copied" ? <Check size={15} /> : state === "failed" ? <TriangleAlert size={15} /> : <Copy size={15} />}
      <span aria-live="polite">{label}</span>
    </button>
  );
}

export function CopyableAddress({
  address,
  resetKey,
  accessibleLabel = "Copy address",
  display,
  className = "",
  onNotice,
}: {
  address: string;
  resetKey?: string;
  accessibleLabel?: string;
  display?: string;
  className?: string;
  onNotice?: (notice: ClipboardNotice) => void;
}) {
  return (
    <div className={`copyable-address ${className}`.trim()}>
      <code title={address}>{display ?? truncateAddress(address)}</code>
      <ClipboardCopyButton
        value={address}
        resetKey={resetKey}
        accessibleLabel={accessibleLabel}
        idleLabel="Copy"
        onNotice={onNotice}
      />
    </div>
  );
}
