import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  ExternalLink,
  FileKey,
  LayoutDashboard,
  ListFilter,
  LogOut,
  LockKeyhole,
  Radio,
  RefreshCw,
  Repeat2,
  Send,
  Settings2,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import {
  connectSigner,
  disconnectSigner,
  generateMnemonic,
  loadDebugMnemonic,
  saveDebugMnemonic,
  signerSnapshot,
  subscribeSigner,
} from "../lib/amp-signer";
import {
  useActiveDeployment,
  useActiveDeploymentId,
  useDeployments,
  useSelectDeployment,
} from "../lib/deployments";
import { activeNavigationTarget, appRoleForPath } from "../lib/navigation";
import { formatUnits, shortHash } from "../lib/domain";
import { useBaseWalletSync, useDeploymentWalletSync } from "../lib/wallet-query";
import { assetBalances, nextFundingAddress } from "../lib/wallet-sync";
import { nativeFeeAssetId } from "../lib/faucet";

export function Brand({ tone }: { tone: "holder" | "issuer" }) {
  return (
    <div className="brand">
      <span className={`brand-mark ${tone}`} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="brand-copy">
        <strong>Simplicity AMP</strong>
        <small>Liquid testnet</small>
      </span>
    </div>
  );
}

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard };

const holderNav: NavItem[] = [
  { to: "/wallet", label: "Overview", icon: LayoutDashboard },
  { to: "/wallet/send", label: "Send", icon: Send },
  { to: "/wallet/receive", label: "Receive", icon: Radio },
];

const issuerNav: NavItem[] = [
  { to: "/admin", label: "Blacklist", icon: ListFilter },
  { to: "/admin/setup", label: "Setup", icon: Settings2 },
  { to: "/admin/reissue", label: "Reissue", icon: Repeat2 },
];

export function AppShell({
  children,
  title,
  eyebrow,
  action,
}: {
  children: ReactNode;
  title: string;
  eyebrow: string;
  action?: ReactNode;
}) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const role = appRoleForPath(path);
  if (!role) throw new Error(`Route ${path} does not belong to an application shell.`);
  const nav = role === "holder" ? holderNav : issuerNav;
  const activeTarget = activeNavigationTarget(path, nav);
  return (
    <div className={`app-shell ${role}`}>
      <aside className="side-rail">
        <Brand tone={role} />
        <nav aria-label={`${role} navigation`}>
          {nav.map((item) => {
            const Icon = item.icon;
            const active = activeTarget === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: true }}
                className={active ? "active" : undefined}
                aria-current={active ? "page" : undefined}
                title={item.label}
              >
                <Icon size={17} strokeWidth={1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="rail-bottom">
          <DeploymentSelector />
          <span className="network-status" aria-label="Liquid testnet network">
            <span className="network-dot" aria-hidden="true" />
            <span className="network-label">Liquid testnet</span>
          </span>
          <a href="https://github.com/BlockstreamResearch/damp" target="_blank" rel="noreferrer">
            <BookOpen size={15} /> Protocol source
          </a>
          <Link to={role === "holder" ? "/admin" : "/wallet"} className="switch-role">
            {role === "holder" ? <ShieldCheck size={15} /> : <WalletCards size={15} />}
            {role === "holder" ? "Issuer console" : "Holder wallet"}
          </Link>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h1>{title}</h1>
          </div>
          <div className="header-action">{action ?? <WalletStatus />}</div>
        </header>
        <div className="page-body"><div className="responsive-deployment-selector"><DeploymentSelector /></div>{children}</div>
      </main>
    </div>
  );
}

function DeploymentSelector() {
  const deployments = useDeployments();
  const activeId = useActiveDeploymentId();
  const selectDeployment = useSelectDeployment();
  if (!deployments.data?.length) return <small>No deployment selected</small>;
  return (
    <label className="deployment-selector">
      <span>Active deployment</span>
      <select
        aria-label="Active deployment"
        value={activeId.data ?? ""}
        onChange={(event) => selectDeployment.mutate(event.target.value)}
      >
        {deployments.data.map((deployment) => (
          <option key={deployment.deploymentId} value={deployment.deploymentId}>
            {deployment.asset.ticker} · {deployment.deploymentId.slice(0, 8)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function WalletStatus() {
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const deployment = useActiveDeployment();
  const deploymentWallet = useDeploymentWalletSync(deployment.data, signer.connected ? signer.fingerprint : undefined);
  const baseWallet = useBaseWalletSync({
    fingerprint: signer.connected && !deployment.data ? signer.fingerprint : undefined,
    network: signer.network,
    enabled: signer.connected && !deployment.data,
  });
  const wallet = deployment.data ? deploymentWallet : baseWallet;
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string>();
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [savedDebugSignerAvailable, setSavedDebugSignerAvailable] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const model = useMemo<WalletPopoverModel | undefined>(() => {
    if (!signer.connected || !signer.fingerprint) return undefined;
    const selected = deployment.data;
    const snapshot = wallet.data?.snapshot;
    const balances = assetBalances(snapshot);
    const feeAsset = selected?.policyAsset ?? (signer.network ? nativeFeeAssetId(signer.network) : undefined);
    const lbtc = balances.find((balance) => balance.assetId === feeAsset);
    const other = balances.filter((balance) => balance.assetId !== feeAsset);
    const syncError = wallet.data?.syncError ?? (wallet.error instanceof Error ? wallet.error.message : undefined);
    const funding = nextFundingAddress(snapshot);
    return {
      fingerprint: signer.fingerprint,
      network: signer.network === "liquid-testnet" ? "Liquid testnet" : "Elements regtest",
      deploymentSelected: Boolean(selected),
      syncState: syncError
          ? "error"
          : wallet.isPending && !snapshot
            ? "loading"
            : wallet.isFetching
              ? "syncing"
              : "synced",
      syncError,
      lbtcConfirmed: formatUnits(lbtc?.confirmed ?? 0n, 8),
      lbtcPending: formatUnits(lbtc?.pending ?? 0n, 8),
      otherAssets: other.map((balance) => ({
        assetId: balance.assetId,
        label: balance.assetId === selected?.regulatedAsset
          ? selected.asset.ticker
          : balance.assetId === selected?.reissuanceToken
            ? "Reissuance token"
            : shortHash(balance.assetId, 6, 4),
        amount: balance.assetId === selected?.regulatedAsset
          ? formatUnits(balance.confirmed, selected.asset.precision)
          : balance.confirmed.toString(),
        pending: balance.pending.toString(),
      })),
      utxoCount: snapshot?.utxos.filter((utxo) => utxo.status === "confirmed" || utxo.status === "unconfirmed").length ?? 0,
      utxos: (snapshot?.utxos ?? [])
        .filter((utxo) => utxo.status === "confirmed" || utxo.status === "unconfirmed")
        .slice(0, 6)
        .map((utxo) => ({
          outpoint: `${utxo.txid}:${utxo.vout}`,
          status: utxo.status,
          amount: utxo.assetId === feeAsset ? `${formatUnits(utxo.amount, 8)} L-BTC` : `${utxo.amount} units`,
        })),
      receiveIndicator: funding
        ? `External #${funding.index} · ${shortHash(funding.confidentialAddress, 11, 7)}`
        : undefined,
    };
  }, [deployment.data, signer, wallet.data, wallet.error, wallet.isFetching, wallet.isPending]);

  useEffect(() => {
    if (!open) return;
    const firstAction = panelRef.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)");
    (firstAction ?? panelRef.current)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || signer.connected) return;
    // Keep the saved debug phrase out of React state and the rendered DOM.
    // Only its availability is exposed; the phrase is read at click time.
    setSavedDebugSignerAvailable(Boolean(loadDebugMnemonic()));
  }, [open, signer.connected]);

  async function connect(input: string) {
    const network = deployment.data?.network ?? "liquid-testnet";
    const normalized = input.trim();
    if (!normalized) throw new Error("Enter a recovery phrase, or type NEW for an unencrypted debug signer.");
    let mnemonic = normalized;
    if (input.trim().toUpperCase() === "NEW") {
      mnemonic = await generateMnemonic();
      saveDebugMnemonic(mnemonic);
    }
    await connectSigner(mnemonic, network);
    return normalized.toUpperCase() === "NEW";
  }

  async function connectFromPopover(input: string) {
    setConnecting(true);
    setConnectionMessage("Opening the local Liquid testnet signer…");
    try {
      const generated = await connect(input);
      setMnemonicInput("");
      if (generated) setSavedDebugSignerAvailable(true);
      setConnectionMessage(generated ? "A new debug signer was generated and saved unencrypted in this browser." : undefined);
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }

  async function connectSavedDebugSigner() {
    const saved = loadDebugMnemonic();
    if (!saved) {
      setSavedDebugSignerAvailable(false);
      setConnectionMessage("No saved debug signer is available in this browser.");
      return;
    }
    await connectFromPopover(saved);
  }

  return (
    <div className="wallet-popover-anchor" ref={containerRef}>
      <button
        ref={triggerRef}
        className="wallet-status"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="amp-signer-wallet-popover"
        aria-label={signer.connected ? `AMP Signer SDK wallet ${signer.fingerprint}` : "Open AMP Signer SDK connection"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={signer.connected ? "status-light" : "status-light muted"} />
        <span>
          <small>AMP Signer SDK</small>
          <strong>{signer.connected ? signer.fingerprint : "Connect signer"}</strong>
        </span>
      </button>
      {open && (
        <WalletPopoverContent
          panelRef={panelRef}
          model={model}
          connecting={connecting}
          connectionMessage={connectionMessage}
          mnemonicInput={mnemonicInput}
          savedDebugSignerAvailable={savedDebugSignerAvailable}
          onMnemonicInput={setMnemonicInput}
          onConnect={(input) => void connectFromPopover(input)}
          onConnectSaved={() => void connectSavedDebugSigner()}
          onRefresh={() => wallet.refetch()}
          onDisconnect={() => {
            disconnectSigner();
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

export type WalletPopoverModel = {
  fingerprint: string;
  network: string;
  deploymentSelected: boolean;
  syncState: "idle" | "loading" | "syncing" | "synced" | "error";
  syncError?: string;
  lbtcConfirmed: string;
  lbtcPending: string;
  otherAssets: Array<{ assetId: string; label: string; amount: string; pending: string }>;
  utxoCount: number;
  utxos: Array<{ outpoint: string; status: "confirmed" | "unconfirmed" | "spent" | "orphaned"; amount: string }>;
  receiveIndicator?: string;
};

export function WalletPopoverContent({
  panelRef,
  model,
  onConnect,
  onRefresh,
  onDisconnect,
  connecting = false,
  connectionMessage,
  mnemonicInput = "",
  savedDebugSignerAvailable = false,
  onMnemonicInput = () => undefined,
  onConnectSaved = () => undefined,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  model?: WalletPopoverModel;
  onConnect: (mnemonic: string) => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  connecting?: boolean;
  connectionMessage?: string;
  mnemonicInput?: string;
  savedDebugSignerAvailable?: boolean;
  onMnemonicInput?: (value: string) => void;
  onConnectSaved?: () => void;
}) {
  if (!model) {
    return (
      <div id="amp-signer-wallet-popover" className="wallet-popover" role="dialog" aria-label="AMP signer wallet" tabIndex={-1} ref={panelRef}>
        <span className="overline">AMP Signer SDK</span>
        <h2>No signer connected</h2>
        <p>Connect a recovery phrase to discover this wallet’s Liquid testnet balances.</p>
        <form className="wallet-connect-form" onSubmit={(event) => { event.preventDefault(); onConnect(mnemonicInput); }}>
          <label>Recovery phrase or NEW<input aria-describedby="wallet-connect-help" autoComplete="off" disabled={connecting} spellCheck={false} type="password" value={mnemonicInput} onChange={(event) => onMnemonicInput(event.target.value)} /></label>
          <small id="wallet-connect-help">Existing phrases stay in signer memory only. NEW is saved unencrypted for explicit local debugging.</small>
          <button className="button primary wide" type="submit" disabled={connecting}>{connecting ? "Connecting…" : "Connect signer"}</button>
          {savedDebugSignerAvailable && <button className="button secondary wide" type="button" disabled={connecting} onClick={onConnectSaved}>Connect saved debug signer</button>}
        </form>
        {connectionMessage && <p className="wallet-popover-error" role="status" aria-live="polite">{connectionMessage}</p>}
      </div>
    );
  }

  const stateLabel = {
    idle: "Awaiting deployment",
    loading: "Loading wallet",
    syncing: "Syncing",
    synced: "Synced",
    error: "Sync error",
  }[model.syncState];

  return (
    <div id="amp-signer-wallet-popover" className="wallet-popover" role="dialog" aria-label="AMP signer wallet" tabIndex={-1} ref={panelRef}>
      <div className="wallet-popover-heading">
        <div>
          <span className="overline">AMP Signer SDK</span>
          <h2>{model.fingerprint}</h2>
        </div>
        <span className={`wallet-sync-state ${model.syncState}`}><i />{stateLabel}</span>
      </div>
      <dl className="wallet-popover-meta">
        <div><dt>Network</dt><dd>{model.network}</dd></div>
        <div><dt>UTXOs</dt><dd>{model.utxoCount}</dd></div>
      </dl>
      <>
          <div className="wallet-popover-balance">
            <span>Available L-BTC</span>
            <strong>{model.lbtcConfirmed} <small>L-BTC</small></strong>
            {model.lbtcPending !== "0" && <small>+ {model.lbtcPending} pending</small>}
          </div>
          {model.otherAssets.length > 0 && (
            <div className="wallet-popover-assets" aria-label="Other asset balances">
              {model.otherAssets.slice(0, 3).map((asset) => (
                <div key={asset.assetId} title={asset.assetId}>
                  <span>{asset.label}</span>
                  <strong>{asset.amount}{asset.pending !== "0" ? ` + ${asset.pending} pending` : ""}</strong>
                </div>
              ))}
              {model.otherAssets.length > 3 && <small>+{model.otherAssets.length - 3} more assets</small>}
            </div>
          )}
          {model.receiveIndicator && <p className="wallet-receive-indicator">Receive · {model.receiveIndicator}</p>}
          {model.utxos.length > 0 && <details className="wallet-popover-utxos"><summary>Current outputs ({model.utxoCount})</summary><div>{model.utxos.map((utxo) => <p key={utxo.outpoint}><code title={utxo.outpoint}>{shortHash(utxo.outpoint, 9, 5)}</code><span>{utxo.status}</span><strong>{utxo.amount}</strong></p>)}</div></details>}
          {!model.deploymentSelected && <p>Base wallet synchronized. Select or create a deployment to discover deployment-bound assets.</p>}
      </>
      {model.syncError && <p className="wallet-popover-error" role="status">{model.syncError}</p>}
      <div className="wallet-popover-actions">
        <button className="button secondary" type="button" onClick={onRefresh} disabled={model.syncState === "loading" || model.syncState === "syncing"}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button className="button secondary" type="button" onClick={onDisconnect}>
          <LogOut size={14} /> Disconnect
        </button>
      </div>
    </div>
  );
}

export function SectionHeading({
  label,
  title,
  aside,
}: {
  label?: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        {label && <span className="overline">{label}</span>}
        <h2>{title}</h2>
      </div>
      {aside}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "blue" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function TechnicalDetails({ children, label = "Technical details" }: { children: ReactNode; label?: string }) {
  return (
    <details className="technical-details">
      <summary>{label}</summary>
      <div>{children}</div>
    </details>
  );
}

export function SafetyNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="safety-note">
      <LockKeyhole size={18} />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

export function BackLink({ to, children }: { to: "/wallet" | "/admin"; children: ReactNode }) {
  return (
    <Link to={to} activeOptions={{ exact: true }} className="back-link">
      <ArrowLeft size={15} /> {children}
    </Link>
  );
}

export function VerifiedLabel({ children }: { children: ReactNode }) {
  return (
    <span className="verified-label">
      <BadgeCheck size={14} /> {children}
    </span>
  );
}

export function ExternalAction({ children }: { children: ReactNode }) {
  return (
    <span className="external-action">
      {children} <ExternalLink size={14} />
    </span>
  );
}

export function FileIcon() {
  return <FileKey size={18} />;
}
