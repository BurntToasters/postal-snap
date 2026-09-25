import type { RefObject } from "react";
import {
  Archive,
  Inbox,
  Mail,
  MailOpen,
  MoreHorizontal,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { strings } from "../../i18n";
import type { MailboxRole } from "../../types";

type LocalView = "drafts" | "outbox" | "snoozed";

interface MessagePaneHeaderProps {
  heading: string;
  shownCount: number;
  activeLocalView?: LocalView;
  query: string;
  submittedQuery: string;
  selecting: boolean;
  bulkBusy: boolean;
  mailboxMoreOpen: boolean;
  mailboxMoreRef: RefObject<HTMLDivElement | null>;
  onToggleSelecting: () => void;
  onOpenMore: (open: boolean) => void;
  onMarkAllRead: () => void;
  onClearSearch: () => void;
}

export function MessagePaneHeader({
  heading,
  shownCount,
  activeLocalView,
  query,
  submittedQuery,
  selecting,
  bulkBusy,
  mailboxMoreOpen,
  mailboxMoreRef,
  onToggleSelecting,
  onOpenMore,
  onMarkAllRead,
  onClearSearch,
}: MessagePaneHeaderProps) {
  return (
    <div className="pane-heading">
      <span>
        <h1>{heading}</h1>
        <small>{strings.mail.itemCount(shownCount)}</small>
      </span>
      <div className="pane-heading-actions">
        {!activeLocalView ? (
          <>
            <button
              type="button"
              className="toolbar-button select-messages-button"
              aria-pressed={selecting}
              onClick={onToggleSelecting}
            >
              {selecting ? strings.mail.doneSelecting : strings.mail.select}
            </button>
            <div className="mailbox-more" ref={mailboxMoreRef}>
              <button
                type="button"
                className="icon-button"
                onClick={() => onOpenMore(!mailboxMoreOpen)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    onOpenMore(true);
                  }
                }}
                aria-expanded={mailboxMoreOpen}
                aria-haspopup="menu"
                aria-controls="mailbox-more-menu"
                aria-label={strings.mail.moreMailboxActions}
                title={strings.mail.moreMailboxActions}
              >
                <MoreHorizontal aria-hidden="true" />
              </button>
              {mailboxMoreOpen ? (
                <div
                  id="mailbox-more-menu"
                  className="mailbox-more-menu app-menu"
                  role="menu"
                  aria-label={strings.mail.moreMailboxActions}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={onMarkAllRead}
                    disabled={bulkBusy}
                  >
                    <MailOpen aria-hidden="true" />
                    {strings.mail.markAllRead}
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {!activeLocalView && (query || submittedQuery) ? (
          <button type="button" className="text-button" onClick={onClearSearch}>
            {strings.mail.clearSearch}
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface BulkBarProps {
  selectedCount: number;
  busy: boolean;
  mailboxRole?: MailboxRole;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onArchive: () => void;
  onJunk: () => void;
  onNotJunk: () => void;
  onTrash: () => void;
}

export function BulkBar({
  selectedCount,
  busy,
  mailboxRole,
  onMarkRead,
  onMarkUnread,
  onArchive,
  onJunk,
  onNotJunk,
  onTrash,
}: BulkBarProps) {
  const disabled = selectedCount === 0 || busy;
  return (
    <div
      className="bulk-bar"
      role="toolbar"
      aria-label={strings.mail.selectedCount(selectedCount)}
    >
      <strong>{strings.mail.selectedCount(selectedCount)}</strong>
      <button type="button" disabled={disabled} onClick={onMarkRead}>
        <MailOpen aria-hidden="true" /> {strings.reader.markRead}
      </button>
      <button type="button" disabled={disabled} onClick={onMarkUnread}>
        <Mail aria-hidden="true" /> {strings.reader.markUnread}
      </button>
      <button type="button" disabled={disabled} onClick={onArchive}>
        <Archive aria-hidden="true" /> {strings.reader.archive}
      </button>
      {mailboxRole === "junk" ? (
        <button type="button" disabled={disabled} onClick={onNotJunk}>
          <Inbox aria-hidden="true" /> {strings.reader.notJunk}
        </button>
      ) : (
        <button type="button" disabled={disabled} onClick={onJunk}>
          <ShieldAlert aria-hidden="true" /> {strings.reader.junk}
        </button>
      )}
      <button type="button" disabled={disabled} onClick={onTrash}>
        <Trash2 aria-hidden="true" /> {strings.reader.trash}
      </button>
    </div>
  );
}
