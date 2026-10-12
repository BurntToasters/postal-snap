import { appName } from "./i18n/common";
import { roleLabels } from "./i18n/mail";

/** Window title for the active account. Unread mail is the Inbox count only. */
export function mailboxWindowTitle(options: {
  unread: number;
  accountLabel?: string;
  severalAccounts: boolean;
}): string {
  const unread = Math.max(0, Math.floor(options.unread));
  if (unread === 0) return appName;
  const count = String(unread);
  const label =
    options.severalAccounts && options.accountLabel?.trim()
      ? options.accountLabel.trim()
      : roleLabels.inbox;
  return `${label} (${count}) — ${appName}`;
}

/** Dock and taskbar count. Zero clears the badge. */
export function unreadBadgeCount(unread: number): number | null {
  const count = Math.max(0, Math.floor(unread));
  if (count === 0) return null;
  return Math.min(count, 9999);
}
