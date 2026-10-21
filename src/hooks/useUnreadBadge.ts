import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { useAppStore } from "../store";
import { unreadBadgeCount } from "../windowTitle";

function accountKey(accounts: Array<{ id: string }>): string {
  return accounts
    .map((account) => account.id)
    .sort()
    .join("\u0000");
}

function safeUnreadCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function useUnreadBadge() {
  const accounts = useAppStore((state) => state.accounts);
  const activeAccountId = useAppStore((state) => state.activeAccountId);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const settings = useAppStore((state) => state.settings);
  const requestVersion = useRef(0);
  const badgeQueue = useRef<Promise<void>>(Promise.resolve());
  const publishBadge = useCallback(
    (count: number, isCurrent: () => boolean) => {
      badgeQueue.current = badgeQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (!isCurrent()) return;
          await api.setUnreadBadge(
            unreadBadgeCount(safeUnreadCount(count)) ?? 0,
          );
        })
        .catch(() => undefined);
    },
    [],
  );
  const scope = settings.badgeScope ?? "activeInbox";
  const accountsKey = accountKey(accounts);
  const activeInboxUnread =
    mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.role === "inbox",
    )?.unreadCount ?? 0;

  useEffect(() => {
    if (scope !== "activeInbox") return;
    const version = ++requestVersion.current;
    const snapshot = { scope, accountsKey, activeAccountId };
    publishBadge(activeInboxUnread, () => {
      const latest = useAppStore.getState();
      return (
        requestVersion.current === version &&
        (latest.settings.badgeScope ?? "activeInbox") === snapshot.scope &&
        latest.activeAccountId === snapshot.activeAccountId &&
        accountKey(latest.accounts) === snapshot.accountsKey
      );
    });
    return () => {
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, [activeAccountId, activeInboxUnread, accountsKey, publishBadge, scope]);

  useEffect(() => {
    if (scope !== "allInboxes") return;
    let disposed = false;
    const snapshot = { scope, accountsKey, activeAccountId };
    const unlisten: Array<() => void> = [];
    const isCurrent = (version: number) => {
      if (disposed || version !== requestVersion.current) return false;
      const latest = useAppStore.getState();
      return (
        (latest.settings.badgeScope ?? "activeInbox") === snapshot.scope &&
        latest.activeAccountId === snapshot.activeAccountId &&
        accountKey(latest.accounts) === snapshot.accountsKey
      );
    };
    const refresh = async () => {
      const version = ++requestVersion.current;
      try {
        const counts = await api.getAccountInboxCounts();
        if (!isCurrent(version)) return;
        const accountIds = new Set(snapshot.accountsKey.split("\u0000"));
        const byAccount = new Map<string, number>();
        for (const count of counts) {
          if (
            !accountIds.has(count.accountId) ||
            byAccount.has(count.accountId)
          )
            continue;
          byAccount.set(count.accountId, safeUnreadCount(count.unreadCount));
        }
        const total = [...byAccount.values()].reduce(
          (sum, unread) => sum + unread,
          0,
        );
        publishBadge(total, () => isCurrent(version));
      } catch {
        // The active account and its mail remain usable if counts are unavailable.
      }
    };
    const keepOrRelease = (subscription: Promise<() => void>) => {
      void subscription.then(
        (release) => {
          if (disposed) release();
          else unlisten.push(release);
        },
        () => undefined,
      );
    };

    keepOrRelease(api.onFolderCountsChanged(() => void refresh()));
    keepOrRelease(api.onSyncState(() => void refresh()));
    void refresh();
    return () => {
      disposed = true;
      requestVersion.current += 1;
      unlisten.forEach((release) => release());
    };
  }, [accountsKey, activeAccountId, publishBadge, scope]);
}
