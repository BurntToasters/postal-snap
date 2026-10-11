import type { MessageSummary } from "./types";

export interface ThreadGroup {
  key: string;
  newest: MessageSummary;
  items: MessageSummary[];
  unread: number;
}

export function threadKey(message: MessageSummary): string {
  return (
    message.threadRoot ||
    `solo:${message.mailboxId}:${message.uid}:${message.id}`
  );
}

/** Loaded messages in this mailbox conversation. Empty for a single message. */
function conversationMembers(
  messages: MessageSummary[],
  message: MessageSummary,
): MessageSummary[] {
  const key = threadKey(message);
  if (key.startsWith("solo:")) return [];
  const members = messages.filter(
    (item) =>
      item.accountId === message.accountId &&
      item.mailboxId === message.mailboxId &&
      threadKey(item) === key,
  );
  if (members.length < 2) return [];
  return members;
}

/** Loaded messages in this mailbox conversation. Empty when fewer than two. */
export function conversationMessages(
  messages: MessageSummary[],
  message: MessageSummary,
): MessageSummary[] {
  return conversationMembers(messages, message);
}

/** Loaded messages in this conversation, newest first. Empty when fewer than two. */
export function conversationIndex(
  messages: MessageSummary[],
  message: MessageSummary,
): MessageSummary[] {
  const members = conversationMembers(messages, message);
  if (members.length < 2) return [];
  return [...members].sort(
    (left, right) =>
      new Date(right.receivedAt).getTime() -
        new Date(left.receivedAt).getTime() || right.uid - left.uid,
  );
}

/** Loaded neighbor in this conversation. `1` is older and `-1` is newer. */
export function conversationNeighbor(
  messages: MessageSummary[],
  message: MessageSummary,
  direction: 1 | -1,
): MessageSummary | undefined {
  const ordered = conversationIndex(messages, message);
  if (ordered.length < 2) return undefined;
  const index = ordered.findIndex((item) => item.id === message.id);
  if (index < 0) return undefined;
  return ordered[index + direction];
}

/**
 * Another unread message in this loaded conversation.
 * Older unread mail comes first. A newer unread message is used when the
 * open message is the oldest unread one.
 */
export function conversationUnreadTarget(
  messages: MessageSummary[],
  message: MessageSummary,
): MessageSummary | undefined {
  const ordered = conversationIndex(messages, message);
  if (ordered.length < 2) return undefined;
  const index = ordered.findIndex((item) => item.id === message.id);
  if (index < 0) return undefined;
  for (let itemIndex = index + 1; itemIndex < ordered.length; itemIndex += 1) {
    if (!ordered[itemIndex].isRead) return ordered[itemIndex];
  }
  for (let itemIndex = 0; itemIndex < index; itemIndex += 1) {
    if (!ordered[itemIndex].isRead) return ordered[itemIndex];
  }
  return undefined;
}

/** Unread messages in the same loaded mailbox conversation. Empty for one message. */
export function conversationUnread(
  messages: MessageSummary[],
  message: MessageSummary,
): MessageSummary[] {
  return conversationMembers(messages, message).filter((item) => !item.isRead);
}

/** Read messages in the same loaded mailbox conversation. Empty for one message. */
export function conversationRead(
  messages: MessageSummary[],
  message: MessageSummary,
): MessageSummary[] {
  return conversationMembers(messages, message).filter((item) => item.isRead);
}

export function groupThreads(messages: MessageSummary[]): ThreadGroup[] {
  const map = new Map<string, MessageSummary[]>();
  for (const message of messages) {
    const key = threadKey(message);
    const list = map.get(key);
    if (list) list.push(message);
    else map.set(key, [message]);
  }
  const byDate = (left: MessageSummary, right: MessageSummary) =>
    new Date(right.receivedAt).getTime() -
      new Date(left.receivedAt).getTime() || right.uid - left.uid;
  const groups = [...map.entries()].map(([key, items]) => {
    const sorted = [...items].sort(byDate);
    return {
      key,
      newest: sorted[0],
      items: sorted,
      unread: items.filter((item) => !item.isRead).length,
    };
  });
  groups.sort((left, right) => {
    const leftPinned = left.items.some((item) => item.pinned) ? 1 : 0;
    const rightPinned = right.items.some((item) => item.pinned) ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    return byDate(left.newest, right.newest);
  });
  return groups;
}

/** Loaded rows with pins first, keeping the current order inside each group. */
export function pinnedFirst(messages: MessageSummary[]): MessageSummary[] {
  if (!messages.some((item) => item.pinned)) return messages;
  return [
    ...messages.filter((item) => item.pinned),
    ...messages.filter((item) => !item.pinned),
  ];
}

/** Next or previous unread message in list order. Wraps within the loaded list. */
export function unreadStep(
  messages: MessageSummary[],
  grouped: boolean,
  currentId: number | undefined,
  delta: 1 | -1,
): MessageSummary | undefined {
  const items = navigationOrder(messages, grouped);
  const index = items.findIndex((item) => item.id === currentId);
  if (delta > 0) {
    const next = items.find(
      (item, itemIndex) => itemIndex > index && !item.isRead,
    );
    if (next) return next;
    return items.find((item) => !item.isRead && item.id !== currentId);
  }
  const start = index === -1 ? items.length : index;
  for (let itemIndex = start - 1; itemIndex >= 0; itemIndex -= 1) {
    if (!items[itemIndex].isRead) return items[itemIndex];
  }
  for (let itemIndex = items.length - 1; itemIndex > index; itemIndex -= 1) {
    if (!items[itemIndex].isRead && items[itemIndex].id !== currentId) {
      return items[itemIndex];
    }
  }
  return undefined;
}

function visibleMessages(
  messages: MessageSummary[],
  grouped: boolean,
): MessageSummary[] {
  return grouped
    ? groupThreads(messages).map((group) => group.newest)
    : pinnedFirst(messages);
}

/**
 * Message to show after the open one leaves the mailbox.
 * A conversation with more mail stays open on its new newest message.
 * Otherwise the row that slides into that place opens, or the previous row
 * when the last row leaves.
 */
export function messageAfterRemoval(
  messages: MessageSummary[],
  grouped: boolean,
  removedId: number,
): MessageSummary | undefined {
  const removed = messages.find((item) => item.id === removedId);
  const remaining = messages.filter((item) => item.id !== removedId);
  const after = visibleMessages(remaining, grouped);
  if (after.length === 0 || !removed) return undefined;
  if (grouped) {
    const key = threadKey(removed);
    const stillThere = remaining.some(
      (item) =>
        item.accountId === removed.accountId &&
        item.mailboxId === removed.mailboxId &&
        threadKey(item) === key,
    );
    if (stillThere) {
      return after.find((item) => threadKey(item) === key);
    }
  }
  const index = visibleMessages(messages, grouped).findIndex(
    (item) => item.id === removedId,
  );
  if (index < 0) return after[0];
  return after[Math.min(index, after.length - 1)];
}

/** Keyboard order for j/k and arrows: the list's visual order. */
export function navigationOrder(
  messages: MessageSummary[],
  grouped: boolean,
): MessageSummary[] {
  return grouped
    ? groupThreads(messages).flatMap((group) => group.items)
    : pinnedFirst(messages);
}

/** Next visible message after these loaded rows leave. The anchor is one of them. */
export function messageAfterRemovals(
  messages: MessageSummary[],
  grouped: boolean,
  removedIds: ReadonlySet<number>,
  anchorId: number,
): MessageSummary | undefined {
  if (!removedIds.has(anchorId)) return undefined;
  const staged = messages.filter(
    (item) => item.id === anchorId || !removedIds.has(item.id),
  );
  const next = messageAfterRemoval(staged, grouped, anchorId);
  if (next && removedIds.has(next.id)) return undefined;
  return next;
}

/** One-based place of this message in the same order previous and next use. */
export function messageListPosition(
  messages: MessageSummary[],
  grouped: boolean,
  currentId: number | undefined,
): { index: number; total: number } | undefined {
  const items = navigationOrder(messages, grouped);
  const index = items.findIndex((item) => item.id === currentId);
  if (index < 0) return undefined;
  return { index: index + 1, total: items.length };
}

/** Neighbor in list order. Previous is toward the top. Next is toward the bottom. */
export function adjacentMessage(
  messages: MessageSummary[],
  grouped: boolean,
  currentId: number | undefined,
  delta: number,
): MessageSummary | undefined {
  const items = navigationOrder(messages, grouped);
  if (items.length === 0) return undefined;
  const index = items.findIndex((item) => item.id === currentId);
  const nextIndex =
    index === -1
      ? delta > 0
        ? 0
        : items.length - 1
      : Math.max(0, Math.min(items.length - 1, index + delta));
  const next = items[nextIndex];
  if (!next || next.id === currentId) return undefined;
  return next;
}
