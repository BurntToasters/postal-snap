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
  groups.sort((left, right) => byDate(left.newest, right.newest));
  return groups;
}
