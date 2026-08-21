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
import { useDeploymentWalletSync } from "../lib/wallet-query";
import { assetBalances, nextFundingAddress } from "../lib/wallet-sync";

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
        <div className="page-body">{children}</div>
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
  const wallet = useDeploymentWalletSync(deployment.data, signer.connected ? signer.fingerprint : undefined);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const model = useMemo<WalletPopoverModel | undefined>(() => {
    if (!signer.connected || !signer.fingerprint) return undefined;
    const selected = deployment.data;
    const snapshot = wallet.data?.snapshot;
    const balances = assetBalances(snapshot);
    const lbtc = selected ? balances.find((balance) => balance.assetId === selected.policyAsset) : undefined;
    const other = selected ? balances.filter((balance) => balance.assetId !== selected.policyAsset) : [];
    const syncError = wallet.data?.syncError ?? (wallet.error instanceof Error ? wallet.error.message : undefined);
    const funding = nextFundingAddress(snapshot);
    return {
      fingerprint: signer.fingerprint,
      network: signer.network === "liquid-testnet" ? "Liquid testnet" : "Elements regtest",
      deploymentSelected: Boolean(selected),
      syncState: !selected
        ? "idle"
        : syncError
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
      receiveIndicator: funding
        ? `External #${funding.index} · ${shortHash(funding.confidentialAddress, 11, 7)}`
        : undefined,
    };
  }, [deployment.data, signer, wallet.data, wallet.error, wallet.isFetching, wallet.isPending]);

  useEffect(() => {
    if (!open) return;
    const firstAction = panelRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
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

  async function connect() {
    const network = deployment.data?.network ?? "liquid-testnet";
    const savedMnemonic = loadDebugMnemonic();
    const input = window.prompt(
      "Enter your BIP39 recovery phrase. Type NEW to create a fresh 12-word debug signer. NEW phrases are saved unencrypted in this browser's local storage.",
      savedMnemonic ?? "",
    );
    if (!input) return;
    let mnemonic = input;
    if (input.trim().toUpperCase() === "NEW") {
      mnemonic = await generateMnemonic();
      saveDebugMnemonic(mnemonic);
      window.alert(`Debug recovery phrase (saved unencrypted in local storage):\n\n${mnemonic}`);
    }
    await connectSigner(mnemonic, network);
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
          onConnect={() => connect().catch((error) => window.alert(error instanceof Error ? error.message : String(error)))}
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
  receiveIndicator?: string;
};

export function WalletPopoverContent({
  panelRef,
  model,
  onConnect,
  onRefresh,
  onDisconnect,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  model?: WalletPopoverModel;
  onConnect: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  if (!model) {
    return (
      <div id="amp-signer-wallet-popover" className="wallet-popover" role="dialog" aria-label="AMP signer wallet" tabIndex={-1} ref={panelRef}>
        <span className="overline">AMP Signer SDK</span>
        <h2>No signer connected</h2>
        <p>Connect a recovery phrase to discover this wallet’s Liquid testnet balances.</p>
        <button className="button primary wide" type="button" onClick={onConnect}>Connect signer</button>
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
      {!model.deploymentSelected ? (
        <p>Select an active deployment to synchronize balances and receive addresses.</p>
      ) : (
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
        </>
      )}
      {model.syncError && <p className="wallet-popover-error" role="status">{model.syncError}</p>}
      <div className="wallet-popover-actions">
        <button className="button secondary" type="button" onClick={onRefresh} disabled={!model.deploymentSelected || model.syncState === "loading"}>
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
    <Link to={to} className="back-link">
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
