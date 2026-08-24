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
  removeSignerProfile,
  renameSignerProfile,
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
import { assetBalances, nextFundingAddress } from "../lib/wallet-sync";
import { liquidTestnetFaucetUrl, nativeFeeAssetId } from "../lib/faucet";
import { hasPendingSignerOperation } from "../lib/signer-operation-state";
import { DeploymentControl } from "./deployment-control";
import { CopyableAddress } from "./copyable-address";
import { SignerProfilePicker } from "./signer-profile-picker";

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
  if (deployments.isPending) return <small role="status">Checking asset registry…</small>;
  if (deployments.error) return <small role="alert" title={deployments.error instanceof Error ? deployments.error.message : String(deployments.error)}>Asset registry unavailable</small>;
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
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [profileAction, setProfileAction] = useState<"add" | "rename" | "remove">();
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
      receiveAddress: funding && signer.profileId && signer.network
        ? {
            address: funding.confidentialAddress,
            index: funding.index,
            resetKey: `${signer.profileId}:${signer.network}:0:${funding.index}`,
          }
        : undefined,
      faucetUrl: signer.network === "liquid-testnet"
        && syncState === "synced"
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
    if (
      signer.connected
      && signer.walletReady
      && connectionNotice?.tone === "progress"
      && connectionNotice.message.includes("Fresh wallet synchronization is required")
    ) {
      setConnectionNotice({ tone: "success", message: "Signer profile switched and wallet synchronization completed." });
    }
  }, [connectionNotice, signer.connected, signer.walletReady]);

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

  async function connect(
    input: string,
    network: "liquid-testnet" | "elements-regtest",
  ) {
    if (deployment.data && deployment.data.network !== network) {
      throw new Error(`This deployment requires ${networkLabel(deployment.data.network)}.`);
    }
    const normalized = input.trim();
    if (!normalized) throw new Error("Enter a recovery phrase, or type NEW for an unencrypted debug signer.");
    let mnemonic = normalized;
    if (input.trim().toUpperCase() === "NEW") {
      mnemonic = await generateMnemonic();
    }
    await connectSigner(mnemonic, network);
    return normalized.toUpperCase() === "NEW";
  }

  async function connectFromPopover(input: string) {
    setConnecting(true);
    setConnectionNotice({ tone: "progress", message: `Opening the local ${networkLabel(connectionNetwork)} signer…` });
    try {
      const generated = await connect(input, connectionNetwork);
      setMnemonicInput("");
      setProfileAction(undefined);
      setConnectionNotice(generated
        ? { tone: "success", message: "A new test-only debug signer was generated and saved unencrypted in this browser." }
        : { tone: "success", message: "Test-only debug signer saved and connected. Wallet discovery has started." });
    } catch (error) {
      setConnectionNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setConnecting(false);
    }
  }

  async function performProfileSwitch(id: string) {
    setConnecting(true);
    try {
      const profile = profiles.find((candidate) => candidate.id === id);
      if (!profile) throw new Error("Unknown signer profile.");
      setConnectionNotice({ tone: "progress", message: `Switching to ${profile.label} and starting a fresh wallet synchronization…` });
      await switchSignerProfile(id, deployment.data?.network);
      setSelectedProfileId(id);
      setProfileAction(undefined);
      setConnectionNotice({ tone: "progress", message: `${profile.label} is active. Fresh wallet synchronization is required before signing.` });
    } catch (error) {
      setConnectionNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setConnecting(false);
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
    void performProfileSwitch(id);
  }

  function beginAddProfile() {
    setSelectedProfileId(undefined);
    setProfileAction("add");
    setMnemonicInput("");
    setConnectionNetwork(deployment.data?.network ?? signer.network ?? "liquid-testnet");
    setConnectionNotice({ tone: "neutral", message: "Add a disposable test signer. Its recovery phrase will be stored unencrypted in this browser for direct switching." });
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
      setConnectionNotice({ tone: "neutral", message: "Debug signer profile and its unencrypted recovery phrase were removed from this browser. Wallet and deployment records remain isolated under the old profile ID." });
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
          connectionNetworkLocked={Boolean(deployment.data)}
          mnemonicInput={mnemonicInput}
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
            if (id) void performProfileSwitch(id);
          }}
          onCancelProfileSwitch={() => setPendingProfileSwitch(undefined)}
          onConnect={(input) => void connectFromPopover(input)}
          onRefresh={() => {
            if (signerMatchesDeployment) void wallet.refetch();
            else setConnectionNotice({ tone: "error", message: `Reconnect the AMP signer for ${networkLabel(deployment.data!.network)}.` });
          }}
          onAddressCopyNotice={setConnectionNotice}
          onFaucetOpened={() => setConnectionNotice({
            tone: "neutral",
            message: "Liquid testnet faucet opened. Refresh to check whether new test funds arrived.",
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
  receiveAddress?: { address: string; index: number; resetKey: string };
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
  onAddressCopyNotice = () => undefined,
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
  profiles?: SignerProfile[];
  activeProfileId?: string;
  selectedProfileId?: string;
  profileAction?: "add" | "rename" | "remove";
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
  onAddressCopyNotice?: (notice: WalletPopoverNotice) => void;
  onFaucetOpened?: () => void;
}) {
  const [profileManagementOpen, setProfileManagementOpen] = useState(false);
  const profileManagementTriggerRef = useRef<HTMLButtonElement>(null);

  if (!model) {
    return (
      <div id="amp-signer-wallet-popover" className={`wallet-popover ${role}`} role="dialog" aria-label="AMP signer wallet" tabIndex={-1} ref={panelRef}>
        <span className="overline">AMP Signer SDK</span>
        <h2>No signer connected</h2>
        <p>Choose a saved disposable debug profile, or add another test-only recovery phrase.</p>
        <form className="wallet-connect-form" onSubmit={(event) => { event.preventDefault(); onConnect(mnemonicInput); }}>
          {profiles.length > 0 && <div className="wallet-profile-remembered"><SignerProfilePicker label="Saved debug profile" profiles={profiles} selectedId={selectedProfileId} onSelect={onProfileSelect} onUseDifferentProfile={onUseDifferentProfile} /><small>Choosing a saved profile switches directly. Its test-only recovery phrase is stored unencrypted in this browser.</small></div>}
          <label>Network<select aria-label="Signer network" disabled={connecting || connectionNetworkLocked} value={connectionNetwork} onChange={(event) => onConnectionNetwork(event.target.value as "liquid-testnet" | "elements-regtest")}><option value="liquid-testnet">Liquid testnet</option><option value="elements-regtest">Elements regtest</option></select></label>
          {connectionNetworkLocked && <small>The selected deployment locks the signer network to {networkLabel(connectionNetwork)}.</small>}
          <label>Recovery phrase or NEW<input aria-describedby="wallet-connect-help" autoComplete="off" disabled={connecting} spellCheck={false} type="password" value={mnemonicInput} onChange={(event) => onMnemonicInput(event.target.value)} /></label>
          <small id="wallet-connect-help"><strong>Debug only:</strong> every profile phrase is saved unencrypted for direct switching and reload testing. Never use a profile that controls real funds. Profiles are different signer phrases, not BIP account indexes.</small>
          <button className="button primary wide" type="submit" disabled={connecting}>{connecting ? "Connecting…" : "Connect and save debug signer"}</button>
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
  const activeProfiles = profiles.length > 0 ? profiles : [{
    id: activeProfileId ?? `connected:${model.fingerprint}`,
    fingerprint: model.fingerprint,
    label: model.profileLabel ?? `Signer ${model.fingerprint}`,
    network: connectionNetwork,
  }];
  const displayedActiveProfileId = activeProfileId ?? activeProfiles[0]?.id;

  function beginProfileManagementAction(action: () => void) {
    setProfileManagementOpen(false);
    action();
  }

  return (
    <div id="amp-signer-wallet-popover" className={`wallet-popover ${role}`} role="dialog" aria-label="AMP signer wallet" tabIndex={-1} ref={panelRef}>
      <div className="wallet-popover-heading">
        <div>
          <span className="overline">AMP Signer SDK</span>
          <h2>Wallet status</h2>
        </div>
        <span className={`wallet-sync-state ${model.syncState}`}><i />{stateLabel}</span>
      </div>
      <div className="wallet-profile-overview">
        <SignerProfilePicker label="Active signer profile" profiles={activeProfiles} selectedId={displayedActiveProfileId} onSelect={onProfileSelect} />
        <button
          className="text-button wallet-profile-manage-trigger"
          type="button"
          ref={profileManagementTriggerRef}
          aria-controls="wallet-profile-management"
          aria-expanded={profileManagementOpen}
          onClick={() => setProfileManagementOpen((value) => !value)}
        >
          <Settings2 size={13} /> Manage profiles
        </button>
      </div>
      {profileManagementOpen && <div id="wallet-profile-management" className="wallet-profile-management" onKeyDown={(event) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); setProfileManagementOpen(false); profileManagementTriggerRef.current?.focus(); }}><p>Disposable debug profiles represent different signer phrases, not BIP derivation accounts. Their phrases are stored unencrypted for testing.</p><div className="wallet-profile-actions"><button aria-label="Add signer profile" className="text-button" type="button" onClick={() => beginProfileManagementAction(onAddProfile)}><Plus size={13} /> Add</button><button aria-label="Rename signer profile" className="text-button" type="button" onClick={() => beginProfileManagementAction(onRenameProfile)}><Pencil size={13} /> Rename</button><button aria-label="Remove signer profile" className="text-button danger" type="button" onClick={() => beginProfileManagementAction(onRemoveProfile)}><Trash2 size={13} /> Remove</button></div></div>}
      {profileAction === "add" && <form className="wallet-profile-editor" onSubmit={(event) => { event.preventDefault(); onConnect(mnemonicInput); }}><strong>Add test-only debug profile</strong><label>Network<select aria-label="Profile network" disabled={connecting || connectionNetworkLocked} value={connectionNetwork} onChange={(event) => onConnectionNetwork(event.target.value as "liquid-testnet" | "elements-regtest")}><option value="liquid-testnet">Liquid testnet</option><option value="elements-regtest">Elements regtest</option></select></label><label>Recovery phrase or NEW<input aria-label="Profile recovery phrase or NEW" autoComplete="off" disabled={connecting} spellCheck={false} type="password" value={mnemonicInput} onChange={(event) => onMnemonicInput(event.target.value)} /></label><small>Stored unencrypted in this browser for disposable testnet/regtest use. Never use a phrase that controls real funds.</small><div><button className="button secondary" type="button" disabled={connecting} onClick={onCancelProfileAction}>Cancel</button><button className="button primary" type="submit" disabled={connecting}>{connecting ? "Connecting…" : "Add and switch"}</button></div></form>}
      {profileAction === "rename" && <form className="wallet-profile-editor" onSubmit={(event) => { event.preventDefault(); onSaveProfileLabel(); }}><strong>Rename signer profile</strong><label>Profile label<input aria-label="Signer profile label" maxLength={32} value={profileLabelInput} onChange={(event) => onProfileLabelInput(event.target.value)} /></label><div><button className="button secondary" type="button" onClick={onCancelProfileAction}>Cancel</button><button className="button primary" type="submit">Save label</button></div></form>}
      {profileAction === "remove" && <div className="wallet-profile-confirm" role="alert"><strong>Remove this profile?</strong><p>The unencrypted debug recovery phrase and profile label will be removed from this browser. Wallet records remain partitioned by the collision-resistant public profile ID.</p><div><button className="button secondary" type="button" onClick={onCancelProfileAction}>Cancel</button><button className="button danger-button" type="button" onClick={onConfirmRemoveProfile}>Remove profile</button></div></div>}
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
          {model.receiveAddress && <CopyableAddress address={model.receiveAddress.address} resetKey={model.receiveAddress.resetKey} accessibleLabel={`Copy external receive address ${model.receiveAddress.index}`} display={`External #${model.receiveAddress.index} · ${shortHash(model.receiveAddress.address, 11, 7)}`} className="wallet-receive-indicator" onNotice={onAddressCopyNotice} />}
          {model.utxos.length > 0 && <details className="wallet-popover-utxos"><summary>Current outputs ({model.utxoCount})</summary><div>{model.utxos.map((utxo) => <p key={utxo.outpoint}><code title={utxo.outpoint}>{shortHash(utxo.outpoint, 9, 5)}</code><span>{utxo.status}</span><strong>{utxo.amount}</strong></p>)}</div></details>}
          {!model.deploymentSelected && <p>Base wallet synchronized. Select or create a deployment to discover deployment-bound assets.</p>}
      </>
      {model.syncError && <p className="wallet-popover-error" role="status">{model.syncError}</p>}
      {model.faucetUrl && <div className="wallet-popover-faucet"><p>The active profile's public testnet receive address will be sent to liquidtestnet.com. Opening the faucet does not confirm funding.</p><a className="button secondary wide" href={model.faucetUrl} target="_blank" rel="noreferrer" onClick={onFaucetOpened}>Request test funds <ExternalLink size={14} /></a></div>}
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
