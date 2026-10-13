import { strings } from "../../i18n";
import { folderLabel } from "../../i18n/mail";
import type { MailboxSummary } from "../../types";

export interface FolderNode {
  mailbox: MailboxSummary;
  children: FolderNode[];
}

/** Build a tree from flat mailbox list using delimiter-based nesting. Keeps
 * the backend's role order (Inbox, Drafts, Sent, …) instead of raw names. */
export function buildTree(mailboxes: MailboxSummary[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const nodeMap = new Map<string, FolderNode>();
  for (const mailbox of mailboxes)
    nodeMap.set(mailbox.name, { mailbox, children: [] });

  for (const mailbox of mailboxes) {
    const node = nodeMap.get(mailbox.name) as FolderNode;
    const delimiter = mailbox.delimiter;
    if (delimiter && mailbox.name.includes(delimiter)) {
      const parentName = mailbox.name.slice(
        0,
        mailbox.name.lastIndexOf(delimiter),
      );
      const parent = nodeMap.get(parentName);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }
  return roots;
}

export function nestedUnread(nodes: FolderNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + node.mailbox.unreadCount + nestedUnread(node.children),
    0,
  );
}

export function mailboxSummary(
  unread: number,
  total: number,
): string | undefined {
  if (unread <= 0 && total <= 0) return undefined;
  if (unread > 0 && total > 0) {
    return `${strings.mail.unreadCount(unread)}, ${strings.mail.itemCount(total)}`;
  }
  if (total > 0) return strings.mail.itemCount(total);
  return strings.mail.unreadCount(unread);
}

export function sidebarOrder(nodes: FolderNode[], ordered: MailboxSummary[]) {
  for (const node of nodes) {
    ordered.push(node.mailbox);
    sidebarOrder(node.children, ordered);
  }
}

/** The first sidebar mailbox with this role. */
export function mailboxByRole(
  mailboxes: MailboxSummary[],
  role: MailboxSummary["role"],
): MailboxSummary | undefined {
  return sidebarMailboxes(mailboxes).find((mailbox) => mailbox.role === role);
}

/** The account Inbox, when this mailbox list has one. */
export function inboxMailbox(
  mailboxes: MailboxSummary[],
): MailboxSummary | undefined {
  return mailboxByRole(mailboxes, "inbox");
}

/** Folders that contain other folders, parents before their children. */
export function parentMailboxIds(mailboxes: MailboxSummary[]): number[] {
  const ids: number[] = [];
  const walk = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      if (node.children.length === 0) continue;
      ids.push(node.mailbox.id);
      walk(node.children);
    }
  };
  walk(buildTree(mailboxes));
  return ids;
}

/** Mailboxes in the same order as the sidebar, parents before their children. */
export function sidebarMailboxes(
  mailboxes: MailboxSummary[],
): MailboxSummary[] {
  const ordered: MailboxSummary[] = [];
  sidebarOrder(buildTree(mailboxes), ordered);
  return ordered;
}

/** The find field appears once a sidebar has this many mailboxes. */
export const MAILBOX_FIND_MIN = 8;

/** Mailboxes whose name matches, plus the parents needed to show them. */
export function mailboxesMatchingQuery(
  mailboxes: MailboxSummary[],
  query: string,
): MailboxSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return mailboxes;
  const matched = new Set<string>();
  for (const mailbox of mailboxes) {
    const label = folderLabel(mailbox).toLowerCase();
    const path = (mailbox.displayName || mailbox.name).toLowerCase();
    if (!label.includes(needle) && !path.includes(needle)) continue;
    matched.add(mailbox.name);
    const delimiter = mailbox.delimiter;
    if (!delimiter || !mailbox.name.includes(delimiter)) continue;
    const parts = mailbox.name.split(delimiter);
    for (let index = 1; index < parts.length; index += 1)
      matched.add(parts.slice(0, index).join(delimiter));
  }
  return mailboxes.filter((mailbox) => matched.has(mailbox.name));
}

/** The next or previous sidebar mailbox with unread mail, wrapping around. */
export function unreadMailboxStep(
  mailboxes: MailboxSummary[],
  activeId: number | undefined,
  direction: 1 | -1,
): MailboxSummary | undefined {
  const order = sidebarMailboxes(mailboxes);
  if (order.length === 0) return undefined;
  const start = order.findIndex((mailbox) => mailbox.id === activeId);
  const from =
    start === -1 ? (direction === 1 ? 0 : order.length - 1) : start + direction;
  for (let step = 0; step < order.length; step += 1) {
    const index = (from + step * direction + order.length * 2) % order.length;
    const mailbox = order[index];
    if (mailbox.id === activeId) continue;
    if (mailbox.unreadCount > 0) return mailbox;
  }
  return undefined;
}

/** Inbox, the open folder, unread folders, and the parents needed to show them. */
export function mailboxesForUnreadView(
  mailboxes: MailboxSummary[],
  unreadOnly: boolean,
  activeMailboxId: number | undefined,
): MailboxSummary[] {
  if (!unreadOnly) return mailboxes;
  const byName = new Map(mailboxes.map((mailbox) => [mailbox.name, mailbox]));
  const kept = new Set<number>();
  for (const mailbox of mailboxes) {
    if (
      mailbox.role === "inbox" ||
      mailbox.unreadCount > 0 ||
      mailbox.id === activeMailboxId
    ) {
      kept.add(mailbox.id);
      let name = mailbox.name;
      const delimiter = mailbox.delimiter;
      while (delimiter && name.includes(delimiter)) {
        name = name.slice(0, name.lastIndexOf(delimiter));
        const parent = byName.get(name);
        if (!parent) break;
        kept.add(parent.id);
      }
    }
  }
  return mailboxes.filter((mailbox) => kept.has(mailbox.id));
}

/** The next sidebar mailbox with unread mail, wrapping past the current one. */
export function nextUnreadMailbox(
  mailboxes: MailboxSummary[],
  activeId: number | undefined,
): MailboxSummary | undefined {
  return unreadMailboxStep(mailboxes, activeId, 1);
}

/** The previous sidebar mailbox with unread mail, wrapping before the current one. */
export function previousUnreadMailbox(
  mailboxes: MailboxSummary[],
  activeId: number | undefined,
): MailboxSummary | undefined {
  return unreadMailboxStep(mailboxes, activeId, -1);
}
