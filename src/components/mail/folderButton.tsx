import { useState, type DragEvent } from "react";
import { Inbox, Pencil, Trash2 } from "lucide-react";
import { strings } from "../../i18n";
import {
  MESSAGE_DRAG_TYPE,
  endMessageDrag,
  messageDragActive,
} from "../../messageDrag";
import type { MailboxRole } from "../../types";

export function FolderButton({
  icon: Icon,
  label,
  pathLabel,
  count,
  summary,
  insideUnread,
  active,
  tone,
  onClick,
  onRename,
  onDelete,
  mailboxId,
  localView,
  onDropMessages,
}: {
  icon: typeof Inbox;
  label: string;
  /** Full folder path when the visible name is only the last part. */
  pathLabel?: string;
  count: number;
  /** Unread and total, for mailboxes that have mail. */
  summary?: string;
  /** Unread mail in nested folders while this folder is closed. */
  insideUnread?: string;
  active: boolean;
  tone?: "warning" | MailboxRole;
  onClick: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  mailboxId?: number;
  localView?: "drafts" | "outbox" | "snoozed";
  onDropMessages?: (mailboxId: number, payload: string) => void;
}) {
  const [dropOver, setDropOver] = useState(false);
  const canDrop = mailboxId != null && !active && onDropMessages != null;
  const fullName = pathLabel && pathLabel !== label ? pathLabel : undefined;
  const accessibleName = fullName
    ? count > 0
      ? `${fullName}, ${strings.mail.unreadCount(count)}`
      : fullName
    : insideUnread
      ? `${label}, ${insideUnread}`
      : undefined;

  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!canDrop || !messageDragActive()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropOver(true);
  }

  function dragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    setDropOver(false);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    if (!canDrop || mailboxId == null || !onDropMessages) return;
    event.preventDefault();
    const payload = event.dataTransfer.getData(MESSAGE_DRAG_TYPE);
    setDropOver(false);
    endMessageDrag();
    if (payload) onDropMessages(mailboxId, payload);
  }

  return (
    <div
      className="folder-row"
      data-context={
        mailboxId != null ? "folder" : localView ? "local-nav" : undefined
      }
      data-mailbox-id={mailboxId}
      data-local-view={localView}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
    >
      <button
        type="button"
        className={`folder ${active ? "active" : ""} ${tone ?? ""} ${dropOver ? "drop-target" : ""}`}
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        aria-label={accessibleName}
        title={
          [fullName, summary, insideUnread].filter(Boolean).join(", ") ||
          undefined
        }
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        {count > 0 ? <strong>{count > 999 ? "999+" : count}</strong> : null}
      </button>
      {onRename ? (
        <button
          type="button"
          className="icon-button folder-action"
          onClick={onRename}
          aria-label={`${strings.mail.rename} ${label}`}
          title={`${strings.mail.rename} ${label}`}
        >
          <Pencil aria-hidden="true" />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          className="icon-button folder-action"
          onClick={onDelete}
          aria-label={`${strings.mail.deleteFolder}: ${label}`}
          title={`${strings.mail.deleteFolder}: ${label}`}
        >
          <Trash2 aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
