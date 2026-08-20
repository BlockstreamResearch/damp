import { useSyncExternalStore, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  ExternalLink,
  FileKey,
  LayoutDashboard,
  ListFilter,
  LockKeyhole,
  Radio,
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

export function Brand({ tone }: { tone: "holder" | "issuer" }) {
  return (
    <div className="brand">
      <span className={`brand-mark ${tone}`} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
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
  role,
  children,
  title,
  eyebrow,
  action,
}: {
  role: "holder" | "issuer";
  children: ReactNode;
  title: string;
  eyebrow: string;
  action?: ReactNode;
}) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const nav = role === "holder" ? holderNav : issuerNav;
  return (
    <div className={`app-shell ${role}`}>
      <aside className="side-rail">
        <Brand tone={role} />
        <nav aria-label={`${role} navigation`}>
          {nav.map((item) => {
            const Icon = item.icon;
            const active = path === item.to;
            return (
              <Link key={item.to} to={item.to} className={active ? "active" : ""}>
                <Icon size={17} strokeWidth={1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="rail-bottom">
          <DeploymentSelector />
          <span className="network-dot" /> Liquid testnet
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

  async function toggle() {
    if (signer.connected) {
      disconnectSigner();
      return;
    }
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
    <button
      className="wallet-status"
      type="button"
      onClick={() => toggle().catch((error) => window.alert(error instanceof Error ? error.message : String(error)))}
    >
      <span className={signer.connected ? "status-light" : "status-light muted"} />
      <span>
        <small>AMP Signer SDK</small>
        <strong>{signer.connected ? signer.fingerprint : "Connect signer"}</strong>
      </span>
    </button>
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
