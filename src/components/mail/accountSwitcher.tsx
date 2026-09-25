import { useEffect, useRef } from "react";
import { ChevronDown, MailPlus, RefreshCw, Settings } from "lucide-react";
import { accountSyncPhase } from "../../accountStatus";
import { strings } from "../../i18n";
import type { AccountInboxCount, AccountSummary, SyncState } from "../../types";

interface Props {
  accounts: AccountSummary[];
  activeAccount?: AccountSummary;
  counts: AccountInboxCount[];
  sync: Record<string, SyncState>;
  open: boolean;
  syncingAll: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (accountId: string) => void;
  onGetAll: () => void;
  onAdd: () => void;
  onSettings: () => void;
}

function accountStatus(
  account: AccountSummary,
  live?: SyncState,
): { className: string; label: string } {
  const phase = accountSyncPhase(account, live);
  if (
    phase === "authFailed" ||
    account.error?.toLowerCase().includes("sign-in")
  ) {
    return {
      className: "auth-failed",
      label: strings.mail.accountSignInNeeded,
    };
  }
  if (phase === "offline")
    return { className: "offline", label: strings.mail.accountOffline };
  if (phase === "syncing" || phase === "connecting")
    return { className: "syncing", label: strings.mail.accountSyncing };
  return { className: "ready", label: strings.mail.accountReady };
}

function initial(account?: AccountSummary): string {
  return (account?.displayName || account?.email || "?")
    .slice(0, 1)
    .toUpperCase();
}

export function AccountSwitcher({
  accounts,
  activeAccount,
  counts,
  sync,
  open,
  syncingAll,
  onOpenChange,
  onSelect,
  onGetAll,
  onAdd,
  onSettings,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(
        "[role='menuitem'][aria-current='true']",
      )
      ?.focus();
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", keydown);
    };
  }, [onOpenChange, open]);

  return (
    <div className="account-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="account-heading account-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-context="account"
        data-account-id={activeAccount?.id}
        onClick={() => onOpenChange(!open)}
      >
        <span
          className="account-avatar"
          data-color={activeAccount?.color ?? undefined}
          aria-hidden="true"
        >
          {initial(activeAccount)}
        </span>
        <span>
          <strong>{activeAccount?.displayName || strings.mail.account}</strong>
          <small>{activeAccount?.email}</small>
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="account-switcher-menu app-menu"
          role="menu"
          aria-label={strings.mail.emailAccounts}
        >
          {accounts.map((account) => {
            const count = counts.find((item) => item.accountId === account.id);
            const status = accountStatus(account, sync[account.id]);
            return (
              <button
                key={account.id}
                type="button"
                role="menuitem"
                aria-current={
                  account.id === activeAccount?.id ? "true" : undefined
                }
                data-context="account"
                data-account-id={account.id}
                onClick={() => {
                  onSelect(account.id);
                  onOpenChange(false);
                  triggerRef.current?.focus();
                }}
              >
                <span
                  className="account-avatar"
                  data-color={account.color ?? undefined}
                  aria-hidden="true"
                >
                  {initial(account)}
                </span>
                <span className="account-switcher-copy">
                  <strong>{account.displayName || account.email}</strong>
                  <small>{account.email}</small>
                  <small className="account-status-label">
                    <i className={`account-status-dot ${status.className}`} />
                    {status.label}
                  </small>
                </span>
                {count?.unreadCount ? (
                  <span
                    className="account-unread"
                    aria-label={`${count.unreadCount} unread`}
                  >
                    {count.unreadCount}
                  </span>
                ) : null}
              </button>
            );
          })}
          <div className="account-switcher-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={onGetAll}
            disabled={syncingAll}
          >
            <RefreshCw
              className={syncingAll ? "spinning" : ""}
              aria-hidden="true"
            />
            <span>{strings.mail.getMailAllAccounts}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAdd();
              onOpenChange(false);
            }}
          >
            <MailPlus aria-hidden="true" />
            <span>{strings.mail.addAccount}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSettings();
              onOpenChange(false);
            }}
          >
            <Settings aria-hidden="true" />
            <span>{strings.mail.accountSettings}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
