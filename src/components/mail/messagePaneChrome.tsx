import type { RefObject } from "react";
import {
  Archive,
  ArrowUpNarrowWide,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock,
  Copy,
  Download,
  FileDown,
  Inbox,
  ListChecks,
  Forward,
  Mail,
  MailOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Printer,
  Send,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { strings } from "../../i18n";
import type { MessageListFilter } from "../../listFilter";
import {
  sortFamily,
  sortIsReversed,
  toggleSortDirection,
  type MessageListSort,
} from "../../listSort";
import type { MailboxRole } from "../../types";
import { moveMenuFocus } from "../toolbarNav";
import { folderIcons } from "./folderIcons";

type LocalView = "drafts" | "outbox" | "snoozed";

interface MessagePaneHeaderProps {
  heading: string;
  /** Shown when more than one account is set up. */
  accountLabel?: string;
  shownCount: number;
  /** Server total for this folder. Used only while the full list is showing. */
  folderTotal?: number;
  /** Unread messages in this folder. Used only while the full list is showing. */
  unreadCount?: number;
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
  onExpandConversations?: () => void;
  onCollapseConversations?: () => void;
  onNextUnread: () => void;
  nextUnreadDisabled: boolean;
  onGoToInbox: () => void;
  goToInboxDisabled: boolean;
  onGoToSent: () => void;
  goToSentDisabled: boolean;
  onNextUnreadMailbox: () => void;
  nextUnreadMailboxDisabled: boolean;
  onPreviousUnreadMailbox: () => void;
  previousUnreadMailboxDisabled: boolean;
  onClearSearch: () => void;
  listFilter: MessageListFilter;
  onListFilter: (filter: MessageListFilter) => void;
  listSort: MessageListSort;
  onListSort: (sort: MessageListSort) => void;
  /** Select mode: actions on the selection, shown in the More menu. */
  selection?: {
    count: number;
    mailboxRole?: MailboxRole;
    onSelectAll: () => void;
    onSelectUnread: () => void;
    selectUnreadDisabled: boolean;
    onMarkRead: () => void;
    onMarkUnread: () => void;
    onStar: () => void;
    onUnstar: () => void;
    onPin: () => void;
    onUnpin: () => void;
    pinDisabled: boolean;
    unpinDisabled: boolean;
    onJunk: () => void;
    onNotJunk: () => void;
    moveDestinations: Array<{
      id: number;
      name: string;
      role: MailboxRole;
    }>;
    onMoveTo: (mailboxId: number) => void;
    onCopyTo: (mailboxId: number) => void;
    onSnooze: () => void;
    onSaveFiles: () => void;
    saveFilesDisabled: boolean;
    onSaveMessages: () => void;
    onPrint: () => void;
    onCopyText: () => void;
    onForward: () => void;
  };
}

export function MessagePaneHeader({
  heading,
  accountLabel,
  shownCount,
  folderTotal,
  unreadCount,
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
  onExpandConversations,
  onCollapseConversations,
  onNextUnread,
  nextUnreadDisabled,
  onGoToInbox,
  goToInboxDisabled,
  onGoToSent,
  goToSentDisabled,
  onNextUnreadMailbox,
  nextUnreadMailboxDisabled,
  onPreviousUnreadMailbox,
  previousUnreadMailboxDisabled,
  onClearSearch,
  listFilter,
  onListFilter,
  listSort,
  onListSort,
  selection,
}: MessagePaneHeaderProps) {
  const selectionDisabled = !selection || selection.count === 0 || bulkBusy;
  const filters: Array<{ id: MessageListFilter; label: string }> = [
    { id: "all", label: strings.mail.filterAll },
    { id: "unread", label: strings.mail.unread },
    { id: "starred", label: strings.mail.starred },
    { id: "pinned", label: strings.mail.pinned },
    { id: "toMe", label: strings.mail.toMe },
    { id: "attachments", label: strings.mail.hasAttachments },
    { id: "invitations", label: strings.mail.invitations },
  ];
  const sorts: Array<{ id: MessageListSort; label: string }> = [
    { id: "date", label: strings.mail.sortDate },
    { id: "sender", label: strings.mail.sortFrom },
    { id: "subject", label: strings.mail.sortSubject },
    { id: "size", label: strings.mail.sortSize },
  ];
  return (
    <>
      <div className="pane-heading">
        <span>
          {accountLabel ? <p className="pane-account">{accountLabel}</p> : null}
          <h1>{heading}</h1>
          <small>
            {[
              unreadCount ? strings.mail.unreadCount(unreadCount) : null,
              folderTotal != null && folderTotal > shownCount && shownCount > 0
                ? strings.mail.loadedOfTotal(shownCount, folderTotal)
                : strings.mail.itemCount(shownCount),
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
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
                    onKeyDownCapture={moveMenuFocus}
                  >
                    {!submittedQuery ? (
                      <>
                        <div
                          role="group"
                          aria-labelledby="mailbox-sort-heading"
                        >
                          <div
                            id="mailbox-sort-heading"
                            className="context-menu-heading"
                          >
                            {strings.mail.sortMessages}
                          </div>
                          {sorts.map((sort) => (
                            <button
                              key={sort.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={sortFamily(listSort) === sort.id}
                              onClick={() => onListSort(sort.id)}
                            >
                              {sort.label}
                            </button>
                          ))}
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={sortIsReversed(listSort)}
                            onClick={() =>
                              onListSort(toggleSortDirection(listSort))
                            }
                          >
                            <ArrowUpNarrowWide aria-hidden="true" />
                            {sortFamily(listSort) === "date"
                              ? strings.mail.sortOldest
                              : sortFamily(listSort) === "size"
                                ? strings.mail.sortSmallest
                                : strings.mail.sortDescending}
                          </button>
                        </div>
                        <div
                          className="context-menu-separator"
                          role="separator"
                        />
                      </>
                    ) : null}
                    {selecting && selection ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={bulkBusy}
                          onClick={selection.onSelectAll}
                        >
                          <ListChecks aria-hidden="true" />
                          {strings.contextMenu.selectAll}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={bulkBusy || selection.selectUnreadDisabled}
                          onClick={selection.onSelectUnread}
                        >
                          <Mail aria-hidden="true" />
                          {strings.contextMenu.selectUnread}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onMarkRead}
                        >
                          <MailOpen aria-hidden="true" />
                          {strings.reader.markRead}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onMarkUnread}
                        >
                          <Mail aria-hidden="true" />
                          {strings.reader.markUnread}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onStar}
                        >
                          <Star aria-hidden="true" />
                          {strings.reader.addStar}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onUnstar}
                        >
                          <Star aria-hidden="true" fill="currentColor" />
                          {strings.reader.removeStar}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled || selection.pinDisabled}
                          onClick={selection.onPin}
                        >
                          <Pin aria-hidden="true" />
                          {strings.mail.pinSelected}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={
                            selectionDisabled || selection.unpinDisabled
                          }
                          onClick={selection.onUnpin}
                        >
                          <PinOff aria-hidden="true" />
                          {strings.mail.unpinSelected}
                        </button>
                        {selection.mailboxRole === "junk" ? (
                          <button
                            type="button"
                            role="menuitem"
                            disabled={selectionDisabled}
                            onClick={selection.onNotJunk}
                          >
                            <Inbox aria-hidden="true" />
                            {strings.reader.notJunk}
                          </button>
                        ) : (
                          <button
                            type="button"
                            role="menuitem"
                            disabled={selectionDisabled}
                            onClick={selection.onJunk}
                          >
                            <ShieldAlert aria-hidden="true" />
                            {strings.reader.junk}
                          </button>
                        )}
                        {selection.moveDestinations.length > 0 ? (
                          <div role="group" aria-labelledby="bulk-move-heading">
                            <div
                              id="bulk-move-heading"
                              className="context-menu-heading"
                            >
                              {strings.contextMenu.moveTo}
                            </div>
                            {selection.moveDestinations.map((mailbox) => {
                              const Icon = folderIcons[mailbox.role];
                              return (
                                <button
                                  key={mailbox.id}
                                  type="button"
                                  role="menuitem"
                                  disabled={selectionDisabled}
                                  aria-label={strings.contextMenu.moveToFolder(
                                    mailbox.name,
                                  )}
                                  onClick={() => selection.onMoveTo(mailbox.id)}
                                >
                                  <Icon aria-hidden="true" />
                                  {mailbox.name}
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                        {selection.moveDestinations.length > 0 ? (
                          <div role="group" aria-labelledby="bulk-copy-heading">
                            <div
                              id="bulk-copy-heading"
                              className="context-menu-heading"
                            >
                              {strings.contextMenu.copyTo}
                            </div>
                            {selection.moveDestinations.map((mailbox) => {
                              const Icon = folderIcons[mailbox.role];
                              return (
                                <button
                                  key={`copy-${mailbox.id}`}
                                  type="button"
                                  role="menuitem"
                                  disabled={selectionDisabled}
                                  aria-label={strings.contextMenu.copyToFolder(
                                    mailbox.name,
                                  )}
                                  onClick={() => selection.onCopyTo(mailbox.id)}
                                >
                                  <Icon aria-hidden="true" />
                                  {mailbox.name}
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          role="menuitem"
                          disabled={
                            selectionDisabled || selection.saveFilesDisabled
                          }
                          onClick={selection.onSaveFiles}
                        >
                          <Download aria-hidden="true" />
                          {strings.reader.saveSelectedFiles}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onSaveMessages}
                        >
                          <FileDown aria-hidden="true" />
                          {strings.reader.saveSelectedMessages}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onPrint}
                        >
                          <Printer aria-hidden="true" />
                          {strings.reader.printSelected}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onCopyText}
                        >
                          <Copy aria-hidden="true" />
                          {strings.reader.copySelectedText}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onForward}
                        >
                          <Forward aria-hidden="true" />
                          {strings.reader.forwardSelected}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={selectionDisabled}
                          onClick={selection.onSnooze}
                        >
                          <Clock aria-hidden="true" />
                          {strings.mail.snoozeSelected}
                        </button>
                        <div
                          className="context-menu-separator"
                          role="separator"
                        />
                      </>
                    ) : null}
                    {onExpandConversations && onCollapseConversations ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={onExpandConversations}
                          disabled={bulkBusy}
                        >
                          <ChevronsUpDown aria-hidden="true" />
                          {strings.mail.expandConversations}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={onCollapseConversations}
                          disabled={bulkBusy}
                        >
                          <ChevronsDownUp aria-hidden="true" />
                          {strings.mail.collapseConversations}
                        </button>
                        <div
                          className="context-menu-separator"
                          role="separator"
                        />
                      </>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onGoToInbox}
                      disabled={goToInboxDisabled || bulkBusy}
                    >
                      <Inbox aria-hidden="true" />
                      {strings.mail.goToInbox}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onGoToSent}
                      disabled={goToSentDisabled || bulkBusy}
                    >
                      <Send aria-hidden="true" />
                      {strings.mail.goToSent}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onNextUnread}
                      disabled={nextUnreadDisabled || bulkBusy}
                    >
                      <Mail aria-hidden="true" />
                      {strings.mail.nextUnread}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onNextUnreadMailbox}
                      disabled={nextUnreadMailboxDisabled || bulkBusy}
                    >
                      <Inbox aria-hidden="true" />
                      {strings.mail.nextUnreadMailbox}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onPreviousUnreadMailbox}
                      disabled={previousUnreadMailboxDisabled || bulkBusy}
                    >
                      <Inbox aria-hidden="true" />
                      {strings.mail.previousUnreadMailbox}
                    </button>
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
            <button
              type="button"
              className="text-button"
              onClick={onClearSearch}
            >
              {strings.mail.clearSearch}
            </button>
          ) : null}
        </div>
      </div>
      {!activeLocalView && !submittedQuery ? (
        <div
          className="mailbox-filter"
          role="radiogroup"
          aria-label={strings.mail.showMessages}
        >
          {filters.map((filter) => (
            <label key={filter.id}>
              <input
                type="radio"
                name="mailbox-filter"
                checked={listFilter === filter.id}
                onChange={() => onListFilter(filter.id)}
              />
              {filter.label}
            </label>
          ))}
        </div>
      ) : null}
    </>
  );
}

// Archive and Trash stay labeled here so the bar fits one row; read state
// and junk sit in the mailbox More menu while selecting.
interface BulkBarProps {
  selectedCount: number;
  busy: boolean;
  onArchive: () => void;
  onTrash: () => void;
  archiveLabel?: string;
  trashLabel?: string;
}

export function BulkBar({
  selectedCount,
  busy,
  onArchive,
  onTrash,
  archiveLabel = strings.reader.archive,
  trashLabel = strings.reader.trash,
}: BulkBarProps) {
  const disabled = selectedCount === 0 || busy;
  return (
    <div
      className="bulk-bar"
      role="toolbar"
      aria-label={strings.mail.selectedCount(selectedCount)}
    >
      <strong>{strings.mail.selectedCount(selectedCount)}</strong>
      <button type="button" disabled={disabled} onClick={onArchive}>
        <Archive aria-hidden="true" /> {archiveLabel}
      </button>
      <button type="button" disabled={disabled} onClick={onTrash}>
        <Trash2 aria-hidden="true" /> {trashLabel}
      </button>
    </div>
  );
}
