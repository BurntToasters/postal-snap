import { useEffect, useState } from "react";
import { accountSyncPhase } from "../../accountStatus";
import { formatMessageDate } from "../../format";
import { strings } from "../../i18n";
import { quietHoursActive } from "../../quietHours";
import { useAppStore } from "../../store";
import type { AccountSummary, SyncProgress, SyncState } from "../../types";

interface SyncStatusProps {
  account: AccountSummary | undefined;
  sync: SyncState | undefined;
  progress?: SyncProgress | undefined;
  onOpenSettings?: (tab?: "accounts", accountId?: string) => void;
}

export function SyncStatus({
  account,
  sync,
  progress,
  onOpenSettings,
}: SyncStatusProps) {
  const quietStart = useAppStore((state) => state.settings.quietHoursStart);
  const quietEnd = useAppStore((state) => state.settings.quietHoursEnd);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!quietStart || !quietEnd) return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [quietStart, quietEnd]);
  const quietUntil =
    quietEnd && quietHoursActive(quietStart, quietEnd, now) ? quietEnd : "";
  const phase = accountSyncPhase(account, sync);

  let detail = sync?.detail ?? account?.error;
  if (!detail) {
    if (phase === "syncing" || phase === "connecting") {
      if (progress && progress.envelopesTotal > 0) {
        detail = strings.mail.downloadingMail(
          progress.envelopesDone,
          progress.envelopesTotal,
        );
      } else {
        detail = strings.mail.checkingMail;
      }
    } else if (phase === "offline") {
      detail = strings.mail.accountOffline;
    } else if (phase === "authFailed") {
      detail = strings.mail.accountSignInNeeded;
    } else if (phase === "error") {
      detail = strings.mail.mailSyncError;
    } else {
      detail = strings.mail.mailUpToDate;
    }
  }
  if (phase === "idle" && !account?.error && sync?.lastSuccessAt) {
    const checked = new Date(sync.lastSuccessAt);
    if (!Number.isNaN(checked.getTime())) {
      const when = formatMessageDate(sync.lastSuccessAt);
      detail = /[.…!]$/.test(detail)
        ? `${detail} ${strings.mail.checkedAt(when)}`
        : `${detail}. ${strings.mail.checkedAt(when)}`;
    }
  }

  const showProgress =
    (phase === "syncing" || phase === "connecting") &&
    progress != null &&
    progress.envelopesTotal > 0;

  return (
    <div className={`sync-indicator ${phase}`} role="status">
      <span aria-hidden="true" />
      <div className="sync-indicator-content">
        <span>{detail}</span>
        {quietUntil ? (
          <span className="quiet-hours-status">
            {strings.mail.quietHoursUntil(quietUntil)}
          </span>
        ) : null}
        {showProgress ? (
          <progress
            className="sync-progress-bar"
            value={progress.envelopesDone}
            max={progress.envelopesTotal}
          />
        ) : null}
        {(phase === "authFailed" || phase === "offline" || phase === "error") &&
        onOpenSettings ? (
          <button
            type="button"
            className="text-button sync-action-button"
            onClick={() => onOpenSettings("accounts", account?.id)}
          >
            {phase === "authFailed"
              ? strings.settings.updatePassword
              : strings.settings.connection}
          </button>
        ) : null}
      </div>
    </div>
  );
}
