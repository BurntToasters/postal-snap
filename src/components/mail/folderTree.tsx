import { useState } from "react";
import { ChevronRight, Inbox } from "lucide-react";
import { folderLabel } from "../../i18n/mail";
import { strings } from "../../i18n";
import type { MailboxRole, MailboxSummary } from "../../types";
import { FolderButton } from "./folderButton";

interface FolderNode {
  mailbox: MailboxSummary;
  children: FolderNode[];
}

/** Build a tree from flat mailbox list using delimiter-based nesting. */
function buildTree(mailboxes: MailboxSummary[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const nodeMap = new Map<string, FolderNode>();

  const sorted = [...mailboxes].sort((a, b) => a.name.localeCompare(b.name));

  for (const mailbox of sorted) {
    const node: FolderNode = { mailbox, children: [] };
    nodeMap.set(mailbox.name, node);

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

interface FolderTreeProps {
  mailboxes: MailboxSummary[];
  activeMailboxId: number | undefined;
  folderIcons: Record<MailboxRole, typeof Inbox>;
  folderDialog: {
    mode: "create" | "rename";
    id?: number;
    name?: string;
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
}: FolderTreeProps) {
  const tree = buildTree(mailboxes);
  return (
    <>
      {tree.map((node) => (
        <FolderTreeNode
          key={node.mailbox.id}
          node={node}
          depth={0}
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
        />
      ))}
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
}: {
  node: FolderNode;
  depth: number;
} & Omit<FolderTreeProps, "mailboxes">) {
  const [expanded, setExpanded] = useState(true);
  const { mailbox, children } = node;
  const Icon = folderIcons[mailbox.role];
  const personal = mailbox.role === "other";
  const label = folderLabel(mailbox);
  const hasChildren = children.length > 0;

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
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          >
            <ChevronRight
              aria-hidden="true"
              className={expanded ? "rotated" : ""}
            />
          </button>
        ) : depth > 0 ? (
          <span className="folder-expand-spacer" />
        ) : null}
        <FolderButton
          icon={Icon}
          label={label}
          count={mailbox.unreadCount}
          active={mailbox.id === activeMailboxId}
          tone={mailbox.role}
          mailboxId={mailbox.id}
          onClick={() => onFolderClick(mailbox)}
          onRename={personal ? () => onRename(mailbox) : undefined}
          onDelete={personal ? () => onDelete(mailbox) : undefined}
        />
      </div>
      {hasChildren && expanded
        ? children.map((child) => (
            <FolderTreeNode
              key={child.mailbox.id}
              node={child}
              depth={depth + 1}
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
            />
          ))
        : null}
    </>
  );
}
