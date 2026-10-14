import { useState } from "react";
import { ChevronRight, Inbox, Search } from "lucide-react";
import { folderLabel, folderPathLabel } from "../../i18n/mail";
import { strings } from "../../i18n";
import type { MailboxRole, MailboxSummary } from "../../types";
import { FolderButton } from "./folderButton";
import {
  MAILBOX_FIND_MIN,
  buildTree,
  mailboxSummary,
  mailboxesMatchingQuery,
  nestedUnread,
  type FolderNode,
} from "./folderTreeModel";

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
