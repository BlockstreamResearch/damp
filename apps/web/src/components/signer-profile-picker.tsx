import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import type { SignerProfile } from "../lib/amp-signer";
import { networkLabel } from "../lib/domain";

type ProfileSummary = Pick<SignerProfile, "id" | "fingerprint" | "label" | "network">;

function displayLabel(profile: ProfileSummary) {
  const label = profile.label.trim();
  return label === profile.fingerprint || label.toLowerCase() === `signer ${profile.fingerprint}`.toLowerCase()
    ? "Signer profile"
    : label;
}

function ProfileIdentity({ profile, compact = false }: { profile: ProfileSummary; compact?: boolean }) {
  return (
    <span className="wallet-profile-identity">
      <strong title={profile.label}>{displayLabel(profile)}</strong>
      <small>
        <span>{profile.fingerprint}</span>
        {!compact && <><span aria-hidden="true">·</span><span>{networkLabel(profile.network)}</span></>}
      </small>
    </span>
  );
}

export function SignerProfilePicker({
  label,
  profiles,
  selectedId,
  onSelect,
  onUseDifferentProfile,
}: {
  label: string;
  profiles: ProfileSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onUseDifferentProfile?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selected = profiles.find((profile) => profile.id === selectedId);
  const choiceCount = profiles.length + (onUseDifferentProfile ? 1 : 0);
  const interactive = choiceCount > 1;

  useEffect(() => {
    if (!open) return;
    const selectedOption = rootRef.current?.querySelector<HTMLElement>("[role='option'][aria-selected='true']");
    const firstOption = rootRef.current?.querySelector<HTMLElement>("[role='option']");
    (selectedOption ?? firstOption)?.focus();

    const dismiss = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, selectedId]);

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function choose(id?: string) {
    if (id) onSelect(id);
    else onUseDifferentProfile?.();
    close(true);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setOpen(true);
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='option']")];
    const currentIndex = options.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const value = (document.activeElement as HTMLElement | null)?.dataset.profileId;
      choose(value || undefined);
      return;
    }
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
    if (event.key === "ArrowUp") nextIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    options[nextIndex]?.focus();
  }

  return (
    <div className="wallet-profile-picker" ref={rootRef}>
      <span className="wallet-profile-picker-label">{label}</span>
      {interactive ? (
        <button
          className="wallet-profile-switcher"
          type="button"
          ref={triggerRef}
          aria-label={label}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={handleTriggerKeyDown}
        >
          {selected ? <ProfileIdentity profile={selected} compact /> : <span className="wallet-profile-placeholder">Use a different signer phrase</span>}
          <ChevronDown className={open ? "open" : undefined} size={15} aria-hidden="true" />
        </button>
      ) : selected ? (
        <div className="wallet-profile-current" aria-label={label}>
          <ProfileIdentity profile={selected} compact />
        </div>
      ) : null}
      {open && (
        <div id={listboxId} className="wallet-profile-listbox" role="listbox" aria-label={label} onKeyDown={handleListboxKeyDown}>
          {onUseDifferentProfile && (
            <button
              className="wallet-profile-option"
              type="button"
              role="option"
              aria-selected={!selected}
              data-profile-id=""
              onClick={() => choose()}
            >
              <span className="wallet-profile-identity">
                <strong>Use a different signer phrase</strong>
                <small>Enter a phrase without changing remembered profiles</small>
              </span>
              {!selected && <Check size={15} aria-hidden="true" />}
            </button>
          )}
          {profiles.map((profile) => (
            <button
              className="wallet-profile-option"
              type="button"
              role="option"
              aria-selected={profile.id === selectedId}
              data-profile-id={profile.id}
              key={profile.id}
              onClick={() => choose(profile.id)}
            >
              <ProfileIdentity profile={profile} />
              {profile.id === selectedId && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
