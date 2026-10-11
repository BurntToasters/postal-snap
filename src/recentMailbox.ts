const dedicatedRoles = new Set(["inbox", "archive", "junk", "trash"]);

let recentMoveMailboxId: number | undefined;

export function clearRecentMoveMailbox() {
  recentMoveMailboxId = undefined;
}

/** Remember a folder the user picked. Inbox, Archive, Junk, and Trash stay on their own actions. */
export function rememberMoveMailbox(mailbox: { id: number; role: string }) {
  if (dedicatedRoles.has(mailbox.role)) return;
  if (recentMoveMailboxId === mailbox.id) return;
  recentMoveMailboxId = mailbox.id;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("postal:recent-move-folder", { detail: mailbox.id }),
  );
}

/** Restore the folder remembered in settings after launch. */
export function hydrateRecentMoveMailbox(id: number | null | undefined) {
  recentMoveMailboxId = id != null && id > 0 ? id : undefined;
}

export function rememberMoveMailboxId(
  mailboxes: { id: number; role: string }[],
  mailboxId: number,
) {
  const mailbox = mailboxes.find((item) => item.id === mailboxId);
  if (mailbox) rememberMoveMailbox(mailbox);
}

/** The last chosen folder comes first when it is still a destination. */
export function withRecentMoveMailbox<T extends { id: number }>(
  boxes: T[],
): T[] {
  if (recentMoveMailboxId == null) return boxes;
  const index = boxes.findIndex((box) => box.id === recentMoveMailboxId);
  if (index <= 0) return boxes;
  return [boxes[index], ...boxes.slice(0, index), ...boxes.slice(index + 1)];
}
