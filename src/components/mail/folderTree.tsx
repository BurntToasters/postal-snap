import { useState } from "react";
import { ChevronRight, Inbox, Search } from "lucide-react";
import { folderLabel, folderPathLabel } from "../../i18n/mail";
import { strings } from "../../i18n";
import type { MailboxRole, MailboxSummary } from "../../types";
import { FolderButton } from "./folderButton";

interface FolderNode {
  mailbox: MailboxSummary;
  children: FolderNode[];
}

/** Build a tree from flat mailbox list using delimiter-based nesting. Keeps
 * the backend's role order (Inbox, Drafts, Sent, …) instead of raw names. */
function buildTree(mailboxes: MailboxSummary[]): FolderNode[] {
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

function nestedUnread(nodes: FolderNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + node.mailbox.unreadCount + nestedUnread(node.children),
    0,
  );
}

function mailboxSummary(unread: number, total: number): string | undefined {
  if (unread <= 0 && total <= 0) return undefined;
  if (unread > 0 && total > 0) {
    return `${strings.mail.unreadCount(unread)}, ${strings.mail.itemCount(total)}`;
  }
  if (total > 0) return strings.mail.itemCount(total);
  return strings.mail.unreadCount(unread);
}

function sidebarOrder(nodes: FolderNode[], ordered: MailboxSummary[]) {
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

interface FolderTreeProps {
  mailboxes: MailboxSummary[];
  activeMailboxId: number | undefined;
  folderIcons: Record<MailboxRole, typeof Inbox>;
  folderDialog: {
    mode: "create" | "rename";
    id?: number;
    name?: string;
    parentLabel?: string;
  } | null;
  folderName: string;
  folderBusy: boolean;
  onFolderClick: (mailbox: MailboxSummary) => void;
  onRename: (mailbox: MailboxSummary) => void;
  onDelete: (mailbox: MailboxSummary) => void;
  onFolderDialogKeyDown: (event: React.KeyboardEvent) => void;
  onFolderNameChange: (value: string) => void;
  onFolderDialogSubmit: () => void;
  onFolderDialogClose: () => void;
  onDropMessages?: (mailboxId: number, payload: string) => void;
  collapsedMailboxIds?: number[];
  onToggleCollapsed?: (mailboxId: number, collapsed: boolean) => void;
}

export function FolderTree({
  mailboxes,
  activeMailboxId,
  folderIcons,
  folderDialog,
  folderName,
  folderBusy,
  onFolderClick,
  onRename,
  onDelete,
  onFolderDialogKeyDown,
  onFolderNameChange,
  onFolderDialogSubmit,
  onFolderDialogClose,
  onDropMessages,
  collapsedMailboxIds = [],
  onToggleCollapsed,
}: FolderTreeProps) {
  const [query, setQuery] = useState("");
  const filtering = query.trim().length > 0;
  const visible = mailboxesMatchingQuery(mailboxes, query);
  const tree = buildTree(visible);
  return (
    <>
      {mailboxes.length >= MAILBOX_FIND_MIN ? (
        <div className="search-box mailbox-find">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            aria-label={strings.mail.findMailbox}
            placeholder={strings.mail.findMailbox}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }}
          />
          {query ? (
            <button
              type="button"
              className="icon-button"
              aria-label={strings.mail.clearSearch}
              onClick={() => setQuery("")}
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {filtering && tree.length === 0 ? (
        <p className="mailbox-find-empty" role="status">
          {strings.mail.noMailboxMatch}
        </p>
      ) : (
        tree.map((node) => (
          <FolderTreeNode
            key={node.mailbox.id}
            node={node}
            depth={0}
            forceExpanded={filtering}
            activeMailboxId={activeMailboxId}
            folderIcons={folderIcons}
            folderDialog={folderDialog}
            folderName={folderName}
            folderBusy={folderBusy}
            onFolderClick={(mailbox) => {
              setQuery("");
              onFolderClick(mailbox);
            }}
            onRename={onRename}
            onDelete={onDelete}
            onFolderDialogKeyDown={onFolderDialogKeyDown}
            onFolderNameChange={onFolderNameChange}
            onFolderDialogSubmit={onFolderDialogSubmit}
            onFolderDialogClose={onFolderDialogClose}
            onDropMessages={onDropMessages}
            collapsedMailboxIds={collapsedMailboxIds}
            onToggleCollapsed={onToggleCollapsed}
          />
        ))
      )}
    </>
  );
}

function FolderTreeNode({
  node,
  depth,
  activeMailboxId,
  folderIcons,
  folderDialog,
  folderName,
  folderBusy,
  onFolderClick,
  onRename,
  onDelete,
  onFolderDialogKeyDown,
  onFolderNameChange,
  onFolderDialogSubmit,
  onFolderDialogClose,
  onDropMessages,
  collapsedMailboxIds = [],
  onToggleCollapsed,
  forceExpanded = false,
}: {
  node: FolderNode;
  depth: number;
  forceExpanded?: boolean;
} & Omit<FolderTreeProps, "mailboxes">) {
  const { mailbox, children } = node;
  const storedCollapsed = (collapsedMailboxIds ?? []).includes(mailbox.id);
  const [pendingCollapsed, setPendingCollapsed] = useState<boolean | null>(
    null,
  );
  if (pendingCollapsed !== null && pendingCollapsed === storedCollapsed) {
    setPendingCollapsed(null);
  }
  const collapsed = pendingCollapsed ?? storedCollapsed;
  const open = forceExpanded || !collapsed;
  const Icon = folderIcons[mailbox.role];
  const personal = mailbox.role === "other";
  const label = folderLabel(mailbox);
  const pathLabel = folderPathLabel(mailbox);
  const hasChildren = children.length > 0;
  const hiddenUnread = open ? 0 : nestedUnread(children);
  const insideUnread =
    hiddenUnread > 0 ? strings.mail.unreadInside(hiddenUnread) : undefined;

  if (folderDialog?.mode === "rename" && folderDialog.id === mailbox.id) {
    return (
      <form
        className="folder-dialog"
        style={{ paddingInlineStart: `${depth * 16}px` }}
        onKeyDown={onFolderDialogKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          onFolderDialogSubmit();
        }}
      >
        {folderDialog.parentLabel ? (
          <p className="folder-dialog-parent">
            {strings.mail.renameFolderInside(folderDialog.parentLabel)}
          </p>
        ) : null}
        <label>
          <span className="visually-hidden">{strings.mail.folderName}</span>
          <input
            autoFocus
            value={folderName}
            maxLength={128}
            onChange={(event) => onFolderNameChange(event.target.value)}
            placeholder={strings.mail.folderName}
          />
        </label>
        <button
          type="submit"
          className="primary-button"
          disabled={folderBusy || !folderName.trim()}
        >
          {strings.mail.rename}
        </button>
        <button
          type="button"
          className="toolbar-button"
          onClick={onFolderDialogClose}
        >
          {strings.common.cancel}
        </button>
      </form>
    );
  }

  return (
    <>
      <div
        className="folder-tree-row"
        style={{ paddingInlineStart: `${depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="folder-expand icon-button"
            onClick={() => {
              const nextCollapsed = !collapsed;
              setPendingCollapsed(nextCollapsed);
              onToggleCollapsed?.(mailbox.id, nextCollapsed);
            }}
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          >
            <ChevronRight
              aria-hidden="true"
              className={open ? "rotated" : ""}
            />
          </button>
        ) : depth > 0 ? (
          <span className="folder-expand-spacer" />
        ) : null}
        <FolderButton
          icon={Icon}
          label={label}
          pathLabel={pathLabel}
          count={mailbox.unreadCount + hiddenUnread}
          summary={mailboxSummary(mailbox.unreadCount, mailbox.totalCount)}
          insideUnread={insideUnread}
          active={mailbox.id === activeMailboxId}
          tone={mailbox.role}
          mailboxId={mailbox.id}
          onClick={() => onFolderClick(mailbox)}
          onRename={personal ? () => onRename(mailbox) : undefined}
          onDelete={personal ? () => onDelete(mailbox) : undefined}
          onDropMessages={onDropMessages}
        />
      </div>
      {hasChildren && open
        ? children.map((child) => (
            <FolderTreeNode
              key={child.mailbox.id}
              node={child}
              depth={depth + 1}
              forceExpanded={forceExpanded}
              activeMailboxId={activeMailboxId}
              folderIcons={folderIcons}
              folderDialog={folderDialog}
              folderName={folderName}
              folderBusy={folderBusy}
              onFolderClick={onFolderClick}
              onRename={onRename}
              onDelete={onDelete}
              onFolderDialogKeyDown={onFolderDialogKeyDown}
              onFolderNameChange={onFolderNameChange}
              onFolderDialogSubmit={onFolderDialogSubmit}
              onFolderDialogClose={onFolderDialogClose}
              onDropMessages={onDropMessages}
              collapsedMailboxIds={collapsedMailboxIds}
              onToggleCollapsed={onToggleCollapsed}
            />
          ))
        : null}
    </>
  );
}
