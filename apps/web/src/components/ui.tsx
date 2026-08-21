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
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Trash2,
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
  removeSignerProfile,
  renameSignerProfile,
  saveDebugMnemonic,
  signerSnapshot,
  subscribeSigner,
  switchSignerProfile,
  type SignerProfile,
} from "../lib/amp-signer";
import {
  useActiveDeployment,
  useActiveDeploymentId,
  useDeployments,
  useSelectDeployment,
} from "../lib/deployments";
import { activeNavigationTarget, appRoleForPath, contextualDocumentTitle, roleSwitchNavigation } from "../lib/navigation";
import { formatUnits, networkLabel, shortHash } from "../lib/domain";
import { useBaseWalletSync, useDeploymentWalletSync, walletSyncPresentation } from "../lib/wallet-query";
import { assetBalances, feeFundingState, nextFundingAddress } from "../lib/wallet-sync";
import { liquidTestnetFaucetUrl, nativeFeeAssetId } from "../lib/faucet";
import { hasPendingSignerOperation } from "../lib/signer-operation-state";
import { DeploymentControl } from "./deployment-control";

export function Brand({ tone, network }: { tone: "holder" | "issuer"; network: string }) {
  return (
    <div className="brand">
      <span className={`brand-mark ${tone}`} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="brand-copy">
        <strong>Simplicity AMP</strong>
        <small>{network}</small>
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
  const deployment = useActiveDeployment();
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const currentNetwork = deployment.data?.network ?? signer.network;
  const currentNetworkLabel = currentNetwork ? networkLabel(currentNetwork) : "Network not selected";
  const nav = role === "holder" ? holderNav : issuerNav;
  const roleSwitch = roleSwitchNavigation(role);
  const activeTarget = activeNavigationTarget(path, nav);
  useEffect(() => {
    document.title = contextualDocumentTitle(title);
  }, [title]);
  return (
    <div className={`app-shell ${role}`}>
      <aside className="side-rail">
        <Brand tone={role} network={currentNetworkLabel} />
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
          <Link
            to={roleSwitch.to}
            className="mobile-role-switch"
            title={roleSwitch.label}
          >
            {role === "holder" ? <ShieldCheck size={17} strokeWidth={1.8} /> : <WalletCards size={17} strokeWidth={1.8} />}
            {roleSwitch.mobileLabel}
          </Link>
        </nav>
        <div className="rail-bottom">
          <DeploymentSelector />
          <span className="network-status" aria-label={`${currentNetworkLabel} network`}>
            <span className="network-dot" aria-hidden="true" />
            <span className="network-label">{currentNetworkLabel}</span>
          </span>
          <a href="https://github.com/BlockstreamResearch/damp" target="_blank" rel="noreferrer">
            <BookOpen size={15} /> Protocol source
          </a>
          <Link to={roleSwitch.to} className="switch-role">
            {role === "holder" ? <ShieldCheck size={15} /> : <WalletCards size={15} />}
            {roleSwitch.label}
          </Link>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h1>{title}</h1>
          </div>
          <div className="header-action">{action ?? <WalletStatus role={role} />}</div>
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
  return <DeploymentControl deployments={deployments.data} activeId={activeId.data ?? undefined} onSelect={(deploymentId) => selectDeployment.mutate(deploymentId)} />;
}

export function WalletStatus({ role = "holder" }: { role?: "holder" | "issuer" } = {}) {
  const signer = useSyncExternalStore(subscribeSigner, signerSnapshot, signerSnapshot);
  const profiles = signer.profiles ?? [];
  const deployment = useActiveDeployment();
  const signerMatchesDeployment = !deployment.data || signer.network === deployment.data.network;
  const deploymentWallet = useDeploymentWalletSync(
    deployment.data,
    signer.connected && signerMatchesDeployment ? signer.profileId : undefined,
  );
  const baseWallet = useBaseWalletSync({
    profileId: signer.connected && !deployment.data ? signer.profileId : undefined,
    network: signer.network,
    enabled: signer.connected && !deployment.data,
  });
  const wallet = deployment.data ? deploymentWallet : baseWallet;
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState<WalletPopoverNotice>();
  const [connectionNetwork, setConnectionNetwork] = useState<"liquid-testnet" | "elements-regtest">(
    deployment.data?.network ?? "liquid-testnet",
  );
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [savedDebugSignerAvailable, setSavedDebugSignerAvailable] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [profileAction, setProfileAction] = useState<"add" | "unlock" | "rename" | "remove">();
  const [profileLabelInput, setProfileLabelInput] = useState("");
  const [pendingProfileSwitch, setPendingProfileSwitch] = useState<string>();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const model = useMemo<WalletPopoverModel | undefined>(() => {
    if (!signer.connected || !signer.fingerprint || !signer.profileId) return undefined;
    const selected = deployment.data;
    const snapshot = wallet.data?.snapshot;
    const balances = assetBalances(snapshot);
    let feeAsset = selected?.policyAsset;
    let feeAssetError: string | undefined;
    if (!feeAsset && signer.network) {
      try {
        feeAsset = nativeFeeAssetId(signer.network);
      } catch (error) {
        feeAssetError = error instanceof Error ? error.message : String(error);
      }
    }
    const lbtc = balances.find((balance) => balance.assetId === feeAsset);
    const other = balances.filter((balance) => balance.assetId !== feeAsset);
    const networkError = selected && signer.network !== selected.network
      ? `Reconnect the AMP signer for ${networkLabel(selected.network)}.`
      : undefined;
    const syncError = networkError
      ?? feeAssetError
      ?? wallet.data?.syncError
      ?? (wallet.error instanceof Error ? wallet.error.message : undefined);
    const presentation = walletSyncPresentation({
      connected: true,
      snapshot,
      pending: wallet.isPending,
      fetching: wallet.isFetching,
      error: networkError || feeAssetError ? new Error(networkError ?? feeAssetError!) : wallet.error,
      syncError: wallet.data?.syncError,
    });
    const funding = nextFundingAddress(snapshot);
    const fundingState = feeAsset ? feeFundingState({
      snapshot,
      assetId: feeAsset,
      minimum: 1_500n,
      syncing: wallet.isFetching || wallet.isPending,
      syncError,
    }) : "loading";
    const activeProfile = profiles.find((profile) => profile.id === signer.profileId);
    const syncState = signer.walletReady === false
      ? presentation.hasSnapshot ? "syncing" : "loading"
      : presentation.state === "stale" ? "stale" : presentation.state === "disconnected" ? "idle" : presentation.state;
    return {
      role,
      fingerprint: signer.fingerprint,
      profileLabel: activeProfile?.label,
      network: signer.network ? networkLabel(signer.network) : "Network unavailable",
      deploymentSelected: Boolean(selected),
      hasSnapshot: presentation.hasSnapshot,
      syncState,
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
      faucetUrl: signer.network === "liquid-testnet"
        && presentation.state === "synced"
        && fundingState === "unfunded"
        && funding
        ? liquidTestnetFaucetUrl(funding.confidentialAddress)
        : undefined,
    };
  }, [deployment.data, profiles, role, signer, wallet.data, wallet.error, wallet.isFetching, wallet.isPending]);

  useEffect(() => {
    if (!signer.connected && deployment.data?.network) setConnectionNetwork(deployment.data.network);
  }, [deployment.data?.network, signer.connected]);

  useEffect(() => {
    if (signer.connected && signer.profileId) {
      setSelectedProfileId(signer.profileId);
      setProfileAction(undefined);
      setPendingProfileSwitch(undefined);
      return;
    }
  }, [signer.connected, signer.profileId]);

  useEffect(() => {
    if (!open) return;
    const firstAction = panelRef.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]");
    (firstAction ?? panelRef.current)?.focus();
    const dismiss = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )];
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  useEffect(() => {
    if (!open || signer.connected) return;
    // Keep the saved debug phrase out of React state and the rendered DOM.
    // Only its availability is exposed; the phrase is read at click time.
    setSavedDebugSignerAvailable(Boolean(loadDebugMnemonic()));
  }, [open, signer.connected]);

  async function connect(
    input: string,
    network: "liquid-testnet" | "elements-regtest",
    expectedProfileId?: string,
  ) {
    if (deployment.data && deployment.data.network !== network) {
      throw new Error(`This deployment requires ${networkLabel(deployment.data.network)}.`);
    }
    const normalized = input.trim();
    if (!normalized) throw new Error("Enter a recovery phrase, or type NEW for an unencrypted debug signer.");
    let mnemonic = normalized;
    if (input.trim().toUpperCase() === "NEW") {
      mnemonic = await generateMnemonic();
      saveDebugMnemonic(mnemonic);
    }
    if (expectedProfileId) await connectSigner(mnemonic, network, { expectedProfileId });
    else await connectSigner(mnemonic, network);
    return normalized.toUpperCase() === "NEW";
  }

  async function connectFromPopover(input: string) {
    setConnecting(true);
    setConnectionNotice({ tone: "progress", message: `Opening the local ${networkLabel(connectionNetwork)} signer…` });
    try {
      const expectedProfileId = profileAction === "unlock" || (!signer.connected && selectedProfileId)
        ? selectedProfileId
        : undefined;
      const generated = await connect(input, connectionNetwork, expectedProfileId);
      setMnemonicInput("");
      setProfileAction(undefined);
      if (generated) setSavedDebugSignerAvailable(true);
      setConnectionNotice(generated
        ? { tone: "success", message: "A new debug signer was generated and saved unencrypted in this browser." }
        : { tone: "success", message: "Signer connected. Wallet discovery has started." });
    } catch (error) {
      setConnectionNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setConnecting(false);
    }
  }

  async function connectSavedDebugSigner() {
    const saved = loadDebugMnemonic();
    if (!saved) {
      setSavedDebugSignerAvailable(false);
      setConnectionNotice({ tone: "error", message: "No saved debug signer is available in this browser." });
      return;
    }
    setSelectedProfileId(undefined);
    setProfileAction("add");
    setConnecting(true);
    setConnectionNotice({ tone: "progress", message: `Opening the saved debug signer on ${networkLabel(connectionNetwork)}…` });
    try {
      await connect(saved, connectionNetwork);
      setProfileAction(undefined);
      setSavedDebugSignerAvailable(true);
      setConnectionNotice({ tone: "success", message: "Saved debug signer connected. Wallet discovery has started." });
    } catch (error) {
      setConnectionNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setConnecting(false);
    }
  }

  function performProfileSwitch(id: string) {
    try {
      const profile = profiles.find((candidate) => candidate.id === id);
      if (!profile) throw new Error("Unknown signer profile.");
      if (!profile.unlocked) {
        setSelectedProfileId(id);
        setConnectionNetwork(profile.network);
        setProfileAction("unlock");
        setMnemonicInput("");
        setConnectionNotice({ tone: "neutral", message: `Enter the recovery phrase for ${profile.label}. It remains in signer memory only.` });
        return;
      }
      switchSignerProfile(id, deployment.data?.network);
      setSelectedProfileId(id);
      setProfileAction(undefined);
      setConnectionNotice({ tone: "progress", message: `${profile.label} is active. Fresh wallet synchronization is required before signing.` });
    } catch (error) {
      setConnectionNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function requestProfileSwitch(id: string) {
    if (!id || id === signer.profileId) return;
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!profile) return;
    if (deployment.data && profile.network !== deployment.data.network) {
      setConnectionNotice({ tone: "error", message: `This deployment requires ${networkLabel(deployment.data.network)}; ${profile.label} uses ${networkLabel(profile.network)}.` });
      return;
    }
    if (hasPendingSignerOperation()) {
      setPendingProfileSwitch(id);
      return;
    }
    performProfileSwitch(id);
  }

  function beginAddProfile() {
    setSelectedProfileId(undefined);
    setProfileAction("add");
    setMnemonicInput("");
    setConnectionNetwork(deployment.data?.network ?? signer.network ?? "liquid-testnet");
    setConnectionNotice({ tone: "neutral", message: "Add a different signer phrase. Existing unlocked profiles remain in memory for quick switching." });
  }

  function beginRenameProfile() {
    const active = profiles.find((profile) => profile.id === signer.profileId);
    if (!active) return;
    setProfileLabelInput(active.label);
    setProfileAction("rename");
  }

  function saveProfileLabel() {
    if (!signer.profileId) return;
    try {
      renameSignerProfile(signer.profileId, profileLabelInput);
      setProfileAction(undefined);
      setConnectionNotice({ tone: "success", message: "Signer profile label updated." });
    } catch (error) {
      setConnectionNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  function confirmRemoveProfile() {
    if (!signer.profileId) return;
    try {
      removeSignerProfile(signer.profileId);
      setSelectedProfileId(undefined);
      setProfileAction(undefined);
      setConnectionNotice({ tone: "neutral", message: "Signer profile metadata removed. No wallet or deployment records were reinterpreted." });
    } catch (error) {
      setConnectionNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    }
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
          <strong>{signer.connected ? profiles.find((profile) => profile.id === signer.profileId)?.label ?? signer.fingerprint : "Connect signer"}</strong>
        </span>
      </button>
      {open && (
        <WalletPopoverContent
          panelRef={panelRef}
          role={role}
          model={model}
          connecting={connecting}
          connectionNotice={connectionNotice}
          connectionNetwork={connectionNetwork}
          connectionNetworkLocked={Boolean(deployment.data || selectedProfileId)}
          mnemonicInput={mnemonicInput}
          savedDebugSignerAvailable={savedDebugSignerAvailable}
          profiles={profiles}
          activeProfileId={signer.profileId}
          selectedProfileId={selectedProfileId}
          profileAction={profileAction}
          profileLabelInput={profileLabelInput}
          pendingProfileSwitch={pendingProfileSwitch}
          onMnemonicInput={setMnemonicInput}
          onConnectionNetwork={setConnectionNetwork}
          onProfileSelect={(id) => {
            setSelectedProfileId(id || undefined);
            if (!signer.connected) {
              const profile = profiles.find((candidate) => candidate.id === id);
              if (profile) setConnectionNetwork(profile.network);
              return;
            }
            requestProfileSwitch(id);
          }}
          onUseDifferentProfile={() => {
            setSelectedProfileId(undefined);
            setProfileAction(signer.connected ? "add" : undefined);
            setMnemonicInput("");
          }}
          onAddProfile={beginAddProfile}
          onRenameProfile={beginRenameProfile}
          onRemoveProfile={() => setProfileAction("remove")}
          onProfileLabelInput={setProfileLabelInput}
          onSaveProfileLabel={saveProfileLabel}
          onCancelProfileAction={() => {
            setProfileAction(undefined);
            setMnemonicInput("");
            setPendingProfileSwitch(undefined);
          }}
          onConfirmRemoveProfile={confirmRemoveProfile}
          onConfirmProfileSwitch={() => {
            const id = pendingProfileSwitch;
            setPendingProfileSwitch(undefined);
            if (id) performProfileSwitch(id);
          }}
          onCancelProfileSwitch={() => setPendingProfileSwitch(undefined)}
          onConnect={(input) => void connectFromPopover(input)}
          onConnectSaved={() => void connectSavedDebugSigner()}
          onRefresh={() => {
            if (signerMatchesDeployment) void wallet.refetch();
            else setConnectionNotice({ tone: "error", message: `Reconnect the AMP signer for ${networkLabel(deployment.data!.network)}.` });
          }}
          onFaucetOpened={() => setConnectionNotice({
            tone: "neutral",
            message: "Liquid testnet faucet opened. Refresh after funding arrives.",
          })}
          onDisconnect={() => {
            disconnectSigner();
            setProfileAction(undefined);
            setPendingProfileSwitch(undefined);
            setConnectionNotice(undefined);
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

export type WalletPopoverModel = {
  role?: "holder" | "issuer";
  fingerprint: string;
  profileLabel?: string;
  network: string;
  deploymentSelected: boolean;
  hasSnapshot?: boolean;
  syncState: "idle" | "loading" | "syncing" | "synced" | "stale" | "error";
  syncError?: string;
  lbtcConfirmed: string;
  lbtcPending: string;
  otherAssets: Array<{ assetId: string; label: string; amount: string; pending: string }>;
  utxoCount: number;
  utxos: Array<{ outpoint: string; status: "confirmed" | "unconfirmed" | "spent" | "orphaned"; amount: string }>;
  receiveIndicator?: string;
  faucetUrl?: string;
};

export type WalletPopoverNotice = {
  tone: "neutral" | "progress" | "success" | "error";
  message: string;
};

export function WalletPopoverContent({
  panelRef,
  model,
  role = model?.role ?? "holder",
  onConnect,
  onRefresh,
  onDisconnect,
  connecting = false,
  connectionNotice,
  connectionNetwork = "liquid-testnet",
  connectionNetworkLocked = false,
  mnemonicInput = "",
  savedDebugSignerAvailable = false,
  profiles = [],
  activeProfileId,
  selectedProfileId,
  profileAction,
  profileLabelInput = "",
  pendingProfileSwitch,
  onMnemonicInput = () => undefined,
  onConnectionNetwork = () => undefined,
  onProfileSelect = () => undefined,
  onUseDifferentProfile = () => undefined,
  onAddProfile = () => undefined,
  onRenameProfile = () => undefined,
  onRemoveProfile = () => undefined,
  onProfileLabelInput = () => undefined,
  onSaveProfileLabel = () => undefined,
  onCancelProfileAction = () => undefined,
  onConfirmRemoveProfile = () => undefined,
  onConfirmProfileSwitch = () => undefined,
  onCancelProfileSwitch = () => undefined,
  onConnectSaved = () => undefined,
  onFaucetOpened = () => undefined,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  role?: "holder" | "issuer";
  model?: WalletPopoverModel;
  onConnect: (mnemonic: string) => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  connecting?: boolean;
  connectionNotice?: WalletPopoverNotice;
  connectionNetwork?: "liquid-testnet" | "elements-regtest";
  connectionNetworkLocked?: boolean;
  mnemonicInput?: string;
  savedDebugSignerAvailable?: boolean;
  profiles?: SignerProfile[];
  activeProfileId?: string;
  selectedProfileId?: string;
  profileAction?: "add" | "unlock" | "rename" | "remove";
  profileLabelInput?: string;
  pendingProfileSwitch?: string;
  onMnemonicInput?: (value: string) => void;
  onConnectionNetwork?: (value: "liquid-testnet" | "elements-regtest") => void;
  onProfileSelect?: (id: string) => void;
  onUseDifferentProfile?: () => void;
  onAddProfile?: () => void;
  onRenameProfile?: () => void;
  onRemoveProfile?: () => void;
  onProfileLabelInput?: (value: string) => void;
  onSaveProfileLabel?: () => void;
  onCancelProfileAction?: () => void;
  onConfirmRemoveProfile?: () => void;
  onConfirmProfileSwitch?: () => void;
  onCancelProfileSwitch?: () => void;
  onConnectSaved?: () => void;
  onFaucetOpened?: () => void;
}) {
  if (!model) {
    return (
      <div id="amp-signer-wallet-popover" className={`wallet-popover ${role}`} role="dialog" aria-label="AMP signer wallet" tabIndex={-1} ref={panelRef}>
        <span className="overline">AMP Signer SDK</span>
        <h2>No signer connected</h2>
        <p>Choose the intended test network, then connect a recovery phrase to discover its wallet balances.</p>
        <form className="wallet-connect-form" onSubmit={(event) => { event.preventDefault(); onConnect(mnemonicInput); }}>
          {profiles.length > 0 && <div className="wallet-profile-remembered"><label>Remembered signer profile<select aria-label="Remembered signer profile" value={selectedProfileId ?? ""} onChange={(event) => onProfileSelect(event.target.value)}><option value="">Use a different signer phrase</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.fingerprint} · {networkLabel(profile.network)} · locked</option>)}</select></label><small>Only public labels, account identities, fingerprints, and networks survive reload. Recovery phrases are not stored here.</small></div>}
          <label>Network<select aria-label="Signer network" disabled={connecting || connectionNetworkLocked} value={connectionNetwork} onChange={(event) => onConnectionNetwork(event.target.value as "liquid-testnet" | "elements-regtest")}><option value="liquid-testnet">Liquid testnet</option><option value="elements-regtest">Elements regtest</option></select></label>
          {connectionNetworkLocked && <small>The selected deployment or remembered profile locks the signer network to {networkLabel(connectionNetwork)}.</small>}
          <label>Recovery phrase or NEW<input aria-describedby="wallet-connect-help" autoComplete="off" disabled={connecting} spellCheck={false} type="password" value={mnemonicInput} onChange={(event) => onMnemonicInput(event.target.value)} /></label>
          <small id="wallet-connect-help">Existing phrases stay in signer memory only. NEW is saved unencrypted for explicit local debugging. Profiles represent different signer phrases, not BIP account indexes.</small>
          <button className="button primary wide" type="submit" disabled={connecting}>{connecting ? "Connecting…" : selectedProfileId ? "Unlock signer profile" : "Connect signer"}</button>
          {savedDebugSignerAvailable && <button className="button secondary wide" type="button" disabled={connecting} onClick={onConnectSaved}>Connect saved debug signer</button>}
          {selectedProfileId && <button className="text-button" type="button" disabled={connecting} onClick={onUseDifferentProfile}>Use a different signer phrase</button>}
        </form>
        {connectionNotice && <p className={`wallet-popover-status ${connectionNotice.tone}`} role="status" aria-live="polite">{connectionNotice.message}</p>}
      </div>
    );
  }

  const stateLabel = {
    idle: "Awaiting deployment",
    loading: "Loading wallet",
    syncing: "Syncing",
    synced: "Synced",
    stale: "Last good state",
    error: "Sync error",
  }[model.syncState];

  return (
    <div id="amp-signer-wallet-popover" className={`wallet-popover ${role}`} role="dialog" aria-label="AMP signer wallet" tabIndex={-1} ref={panelRef}>
      <div className="wallet-popover-heading">
        <div>
          <span className="overline">AMP Signer SDK</span>
          <h2>{model.profileLabel ?? `Signer ${model.fingerprint}`}</h2>
          <small className="wallet-profile-fingerprint">{model.fingerprint} · derivation account 0</small>
        </div>
        <span className={`wallet-sync-state ${model.syncState}`}><i />{stateLabel}</span>
      </div>
      <div className="wallet-profile-manager">
        <label>Active signer profile<select aria-label="Active signer profile" value={activeProfileId ?? ""} onChange={(event) => onProfileSelect(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.fingerprint} · {networkLabel(profile.network)}{profile.unlocked ? "" : " · locked"}</option>)}</select></label>
        <small>Profiles are different signer phrases; they are not BIP account-index choices.</small>
        <div className="wallet-profile-actions"><button className="text-button" type="button" onClick={onAddProfile}><Plus size={13} /> Add</button><button className="text-button" type="button" onClick={onRenameProfile}><Pencil size={13} /> Rename</button><button className="text-button danger" type="button" onClick={onRemoveProfile}><Trash2 size={13} /> Remove</button></div>
      </div>
      {(profileAction === "add" || profileAction === "unlock") && <form className="wallet-profile-editor" onSubmit={(event) => { event.preventDefault(); onConnect(mnemonicInput); }}><strong>{profileAction === "unlock" ? "Unlock remembered profile" : "Add signer profile"}</strong><label>Network<select aria-label="Profile network" disabled={connecting || connectionNetworkLocked} value={connectionNetwork} onChange={(event) => onConnectionNetwork(event.target.value as "liquid-testnet" | "elements-regtest")}><option value="liquid-testnet">Liquid testnet</option><option value="elements-regtest">Elements regtest</option></select></label><label>Recovery phrase or NEW<input aria-label="Profile recovery phrase or NEW" autoComplete="off" disabled={connecting} spellCheck={false} type="password" value={mnemonicInput} onChange={(event) => onMnemonicInput(event.target.value)} /></label><small>The phrase is kept in memory only, except the existing explicit NEW debug behavior.</small><div><button className="button secondary" type="button" disabled={connecting} onClick={onCancelProfileAction}>Cancel</button><button className="button primary" type="submit" disabled={connecting}>{connecting ? "Connecting…" : profileAction === "unlock" ? "Unlock and switch" : "Add and switch"}</button></div></form>}
      {profileAction === "rename" && <form className="wallet-profile-editor" onSubmit={(event) => { event.preventDefault(); onSaveProfileLabel(); }}><strong>Rename signer profile</strong><label>Profile label<input aria-label="Signer profile label" maxLength={32} value={profileLabelInput} onChange={(event) => onProfileLabelInput(event.target.value)} /></label><div><button className="button secondary" type="button" onClick={onCancelProfileAction}>Cancel</button><button className="button primary" type="submit">Save label</button></div></form>}
      {profileAction === "remove" && <div className="wallet-profile-confirm" role="alert"><strong>Remove this profile?</strong><p>Public profile metadata is removed and its in-memory signer is locked. Wallet records remain partitioned by a collision-resistant public account identity.</p><div><button className="button secondary" type="button" onClick={onCancelProfileAction}>Cancel</button><button className="button danger-button" type="button" onClick={onConfirmRemoveProfile}>Remove profile</button></div></div>}
      {pendingProfileSwitch && <div className="wallet-profile-confirm" role="alertdialog" aria-label="Confirm signer profile switch"><strong>A reviewed operation is still open</strong><p>Switching profiles clears the current review context and requires a fresh wallet sync. Continue?</p><div><button className="button secondary" type="button" onClick={onCancelProfileSwitch}>Stay here</button><button className="button primary" type="button" onClick={onConfirmProfileSwitch}>Switch profile</button></div></div>}
      <dl className="wallet-popover-meta">
        <div><dt>Network</dt><dd>{model.network}</dd></div>
        <div><dt>UTXOs</dt><dd>{model.utxoCount}</dd></div>
      </dl>
      <>
          <div className="wallet-popover-balance">
            <span>Available L-BTC</span>
            {model.hasSnapshot !== false ? <><strong>{model.lbtcConfirmed} <small>L-BTC</small></strong>{model.lbtcPending !== "0" && <small>+ {model.lbtcPending} pending</small>}</> : <strong className="wallet-balance-unknown">Balance unavailable</strong>}
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
      {model.faucetUrl && <div className="wallet-popover-faucet"><p>The public testnet receive address will be sent to liquidtestnet.com.</p><a className="button secondary wide" href={model.faucetUrl} target="_blank" rel="noreferrer" onClick={onFaucetOpened}>Get testnet L-BTC <ExternalLink size={14} /></a></div>}
      {connectionNotice && <p className={`wallet-popover-status ${connectionNotice.tone}`} role="status" aria-live="polite">{connectionNotice.message}</p>}
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
