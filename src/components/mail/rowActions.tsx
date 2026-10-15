import type { MouseEvent } from "react";
import { Archive, Inbox, Mail, MailOpen, Star, Trash2 } from "lucide-react";
import { strings } from "../../i18n";
import type { MessageSummary } from "../../types";

interface RowActionsProps {
  /** The listed message, or the newest message of a conversation. */
  message: MessageSummary;
  conversation: boolean;
  starred: boolean;
  unread: boolean;
  /** Archive rows move back to Inbox. */
  fromArchive: boolean;
  /** Trash rows delete for good. */
  inTrash: boolean;
  onStar?: () => void;
  onRead?: () => void;
  onArchive?: (message: MessageSummary, conversation: boolean) => void;
  onTrash?: (message: MessageSummary, conversation: boolean) => void;
}

// Pointer shortcuts only. The row names every state, and the keys
// (s, u, e, Delete) and the context menu do the same work.
export function RowActions({
  message,
  conversation,
  starred,
  unread,
  fromArchive,
  inTrash,
  onStar,
  onRead,
  onArchive,
  onTrash,
}: RowActionsProps) {
  const reader = strings.reader;
  const starLabel = conversation
    ? starred
      ? reader.unstarConversation
      : reader.starConversation
    : starred
      ? reader.removeStar
      : reader.addStar;
  const readLabel = conversation
    ? unread
      ? reader.markConversationRead
      : reader.markConversationUnread
    : unread
      ? reader.markRead
      : reader.markUnread;
  const archiveLabel = fromArchive
    ? conversation
      ? reader.moveConversationToInbox
      : reader.moveToInbox
    : conversation
      ? reader.archiveConversation
      : reader.archive;
  const trashLabel = inTrash
    ? strings.mail.deleteForever
    : conversation
      ? reader.trashConversation
      : reader.trash;
  // A double-click must not reach the row that slides under the pointer.
  const once = (act: () => void) => (event: MouseEvent) => {
    if (event.detail > 1) return;
    act();
  };
  if (!onStar && !onRead && !onArchive && !onTrash) return null;
  return (
    <div
      className="row-actions"
      aria-hidden="true"
      onContextMenu={(event) => {
        // The row owns the menu target; replay the click on it.
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.parentElement
          ?.querySelector(".message-row")
          ?.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: event.clientX,
              clientY: event.clientY,
              button: 2,
            }),
          );
      }}
      // Keep focus on the row and start no drag.
      onMouseDown={(event) => event.preventDefault()}
    >
      {onStar ? (
        <button
          type="button"
          className={`row-action${starred ? " starred" : ""}`}
          data-action="star"
          tabIndex={-1}
          aria-pressed={starred}
          aria-label={starLabel}
          title={`${starLabel} (s)`}
          onClick={onStar}
        >
          <Star fill={starred ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      ) : null}
      {onRead ? (
        <button
          type="button"
          className="row-action"
          data-action="read"
          tabIndex={-1}
          aria-label={readLabel}
          title={`${readLabel} (u)`}
          onClick={onRead}
        >
          {unread ? (
            <MailOpen aria-hidden="true" />
          ) : (
            <Mail aria-hidden="true" />
          )}
        </button>
      ) : null}
      {onArchive ? (
        <button
          type="button"
          className="row-action"
          data-action="archive"
          tabIndex={-1}
          aria-label={archiveLabel}
          title={`${archiveLabel} (e)`}
          onClick={once(() => onArchive(message, conversation))}
        >
          {fromArchive ? (
            <Inbox aria-hidden="true" />
          ) : (
            <Archive aria-hidden="true" />
          )}
        </button>
      ) : null}
      {onTrash ? (
        <button
          type="button"
          className="row-action"
          data-action="trash"
          tabIndex={-1}
          aria-label={trashLabel}
          title={`${trashLabel} (Delete)`}
          onClick={once(() => onTrash(message, conversation))}
        >
          <Trash2 aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
