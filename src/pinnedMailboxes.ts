import type { PinnedMailbox } from "./types";

export const PINNED_MAILBOX_LIMIT = 30;

export function mailboxIsPinned(
  pins: PinnedMailbox[] | undefined,
  accountId: string | undefined,
  mailboxId: number,
): boolean {
  if (!accountId) return false;
  return (pins ?? []).some(
    (pin) => pin.accountId === accountId && pin.mailboxId === mailboxId,
  );
}

/** Append one mailbox, or leave the list unchanged when it is already listed or full. */
export function pinMailbox(
  pins: PinnedMailbox[] | undefined,
  accountId: string,
  mailboxId: number,
  limit = PINNED_MAILBOX_LIMIT,
): PinnedMailbox[] | undefined {
  const current = pins ?? [];
  if (mailboxIsPinned(current, accountId, mailboxId)) return undefined;
  if (current.length >= limit) return undefined;
  return [...current, { accountId, mailboxId }];
}

export const HIDDEN_MAILBOX_LIMIT = 100;

/** Hide a folder other than Inbox. */
export function hideMailbox(
  hidden: PinnedMailbox[] | undefined,
  accountId: string,
  mailbox: { id: number; role: string },
): PinnedMailbox[] | undefined {
  if (mailbox.role === "inbox") return undefined;
  return pinMailbox(hidden, accountId, mailbox.id, HIDDEN_MAILBOX_LIMIT);
}

/** Close every folder that contains another folder. Already closed folders stay closed. */
export function collapseFolders(
  collapsed: PinnedMailbox[] | undefined,
  accountId: string,
  parentIds: number[],
): PinnedMailbox[] | undefined {
  let next = collapsed ?? [];
  let changed = false;
  for (const mailboxId of parentIds) {
    const pinned = pinMailbox(next, accountId, mailboxId, 200);
    if (!pinned) continue;
    next = pinned;
    changed = true;
  }
  return changed ? next : undefined;
}

/** Open every folder that contains another folder. */
export function expandFolders(
  collapsed: PinnedMailbox[] | undefined,
  accountId: string,
  parentIds: number[],
): PinnedMailbox[] | undefined {
  const parents = new Set(parentIds);
  const current = collapsed ?? [];
  const next = current.filter(
    (entry) => entry.accountId !== accountId || !parents.has(entry.mailboxId),
  );
  return next.length === current.length ? undefined : next;
}

export function unpinMailbox(
  pins: PinnedMailbox[] | undefined,
  accountId: string,
  mailboxId: number,
): PinnedMailbox[] {
  return (pins ?? []).filter(
    (pin) => pin.accountId !== accountId || pin.mailboxId !== mailboxId,
  );
}
