import { accountSyncPhase } from "../../accountStatus";
import { strings } from "../../i18n";
import type { AccountSummary, SyncProgress, SyncState } from "../../types";

interface SyncStatusProps {
  account: AccountSummary | undefined;
  sync: SyncState | undefined;
  progress?: SyncProgress | undefined;
  onOpenSettings?: (tab?: "accounts") => void;
}

export function SyncStatus({
  account,
  sync,
  progress,
  onOpenSettings,
}: SyncStatusProps) {
  const phase = accountSyncPhase(account, sync);

  let detail = sync?.detail ?? account?.error;
  if (!detail) {
    if (phase === "syncing" || phase === "connecting") {
      if (progress && progress.envelopesTotal > 0) {
        detail = `Downloading ${progress.envelopesDone.toLocaleString()} of ${progress.envelopesTotal.toLocaleString()}`;
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

  const showProgress =
    (phase === "syncing" || phase === "connecting") &&
    progress != null &&
    progress.envelopesTotal > 0;

  return (
    <div className={`sync-indicator ${phase}`} role="status">
      <span aria-hidden="true" />
      <div className="sync-indicator-content">
        <span>{detail}</span>
        {showProgress ? (
          <progress
            className="sync-progress-bar"
            value={progress.envelopesDone}
            max={progress.envelopesTotal}
          />
        ) : null}
        {phase === "authFailed" && onOpenSettings ? (
          <button
            type="button"
            className="text-button sync-action-button"
            onClick={() => onOpenSettings("accounts")}
          >
            {strings.settings.updatePassword}
          </button>
        ) : null}
      </div>
    </div>
  );
}
