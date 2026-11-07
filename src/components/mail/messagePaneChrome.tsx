import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Archive,
  ChevronDown,
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
  Ellipsis,
  Pin,
  PinOff,
  Printer,
  Send,
  ShieldAlert,
  Star,
  Trash,
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
import { PopupEntries, type PopupEntry } from "../ContextMenu";
import { placeAnchoredMenu, syncScrollCue } from "../popupPlacement";
import { moveMenuFocus } from "../toolbarNav";
import { usePopupMenu } from "../usePopupMenu";
import { folderIcons } from "./folderIcons";

type LocalView = "drafts" | "outbox" | "snoozed";

interface MessagePaneHeaderProps {
  heading: string;
  /** Shown in the heading actions for Drafts, Outbox, and Snoozed. */
  localAction?: ReactNode;
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
    anySelectedUnread: boolean;
    anySelectedRead: boolean;
    anySelectedUnstarred: boolean;
    anySelectedStarred: boolean;
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
  localAction,
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
  const primaryFilters: Array<{ id: MessageListFilter; label: string }> = [
    { id: "all", label: strings.mail.filterAll },
    { id: "unread", label: strings.mail.unread },
    { id: "starred", label: strings.mail.starred },
  ];
  const moreFilters: Array<{ id: MessageListFilter; label: string }> = [
    { id: "pinned", label: strings.mail.pinned },
    { id: "toMe", label: strings.mail.toMe },
    { id: "attachments", label: strings.mail.hasAttachments },
    { id: "invitations", label: strings.mail.invitations },
  ];
  const activeMore = moreFilters.find((filter) => filter.id === listFilter);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  usePopupMenu(filterMenuOpen, filterMenuRef, () => setFilterMenuOpen(false));
  // Fixed placement escapes the pane's overflow; flips up when roomier.
  useLayoutEffect(() => {
    if (!filterMenuOpen) return;
    const root = filterMenuRef.current;
    const trigger = root?.querySelector<HTMLElement>(
      "button[aria-haspopup='menu']",
    );
    const menu = root?.querySelector<HTMLElement>("[role='menu']");
    if (!trigger || !menu) return;
    const edge = 8;
    const gap = 6;
    const anchor = trigger.getBoundingClientRect();
    menu.style.maxHeight = "";
    const pane = trigger.closest(".message-pane")?.getBoundingClientRect();
    const lo = Math.max(edge, (pane?.left ?? 0) + edge);
    const hi = Math.min(window.innerWidth, pane?.right ?? Infinity) - edge;
    menu.style.minWidth = `min(12rem, ${hi - lo}px)`;
    menu.style.maxWidth = `${hi - lo}px`;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const below = window.innerHeight - anchor.bottom - gap - edge;
    const above = anchor.top - gap - edge;
    const up = height > below && above > below;
    const room = Math.max(up ? above : below, 0);
    const shown = Math.min(height, room);
    menu.style.maxHeight = `${room}px`;
    menu.style.top = `${up ? anchor.top - gap - shown : anchor.bottom + gap}px`;
    const fit = Math.min(width, hi - lo);
    menu.style.left = `${Math.max(lo, Math.min(anchor.right - fit, hi - fit))}px`;
    const close = () => setFilterMenuOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [filterMenuOpen]);
  const sorts: Array<{ id: MessageListSort; label: string }> = [
    { id: "date", label: strings.mail.sortDate },
    { id: "sender", label: strings.mail.sortFrom },
    { id: "subject", label: strings.mail.sortSubject },
    { id: "size", label: strings.mail.sortSize },
  ];

  // Sort is a submenu of fields plus a direction pair. While selecting, the
  // selection actions replace the sort group.
  const reversed = sortIsReversed(listSort);
  const directionLabels =
    sortFamily(listSort) === "date"
      ? [strings.contextMenu.newestFirst, strings.mail.sortOldest]
      : sortFamily(listSort) === "size"
        ? [strings.contextMenu.largestFirst, strings.mail.sortSmallest]
        : [strings.contextMenu.atoZ, strings.mail.sortDescending];
  const sortEntries: PopupEntry[] = [
    {
      kind: "submenu",
      id: "sort-by",
      label: strings.contextMenu.sortBy,
      entries: sorts.map((sort) => ({
        kind: "action",
        id: `sort-${sort.id}`,
        label: sort.label,
        role: "menuitemradio",
        checked: sortFamily(listSort) === sort.id,
        onSelect: () => onListSort(sort.id),
      })),
    },
    {
      kind: "action",
      id: "sort-newest",
      label: directionLabels[0],
      role: "menuitemradio",
      checked: !reversed,
      onSelect: () => {
        if (reversed) onListSort(toggleSortDirection(listSort));
      },
    },
    {
      kind: "action",
      id: "sort-oldest",
      label: directionLabels[1],
      role: "menuitemradio",
      checked: reversed,
      onSelect: () => {
        if (!reversed) onListSort(toggleSortDirection(listSort));
      },
    },
    { kind: "separator" },
  ];
  const selectionEntries: PopupEntry[] = selection
    ? [
        {
          kind: "action",
          id: "select-all",
          label: strings.contextMenu.selectAll,
          icon: ListChecks,
          disabled: bulkBusy,
          onSelect: selection.onSelectAll,
        },
        {
          kind: "action",
          id: "select-unread",
          label: strings.contextMenu.selectUnread,
          icon: Mail,
          disabled: bulkBusy || selection.selectUnreadDisabled,
          onSelect: selection.onSelectUnread,
        },
        // A mixed selection offers both sides of read, star, and pin.
        ...(selection.anySelectedUnread
          ? [
              {
                kind: "action" as const,
                id: "mark-read",
                label: strings.reader.markRead,
                icon: MailOpen,
                disabled: selectionDisabled,
                onSelect: selection.onMarkRead,
              },
            ]
          : []),
        ...(selection.anySelectedRead || !selection.anySelectedUnread
          ? [
              {
                kind: "action" as const,
                id: "mark-unread",
                label: strings.reader.markUnread,
                icon: Mail,
                disabled: selectionDisabled,
                onSelect: selection.onMarkUnread,
              },
            ]
          : []),
        ...(selection.anySelectedUnstarred
          ? [
              {
                kind: "action" as const,
                id: "star",
                label: strings.reader.addStar,
                icon: Star,
                disabled: selectionDisabled,
                onSelect: selection.onStar,
              },
            ]
          : []),
        ...(selection.anySelectedStarred || !selection.anySelectedUnstarred
          ? [
              {
                kind: "action" as const,
                id: "unstar",
                label: strings.reader.removeStar,
                icon: Star,
                disabled: selectionDisabled,
                onSelect: selection.onUnstar,
              },
            ]
          : []),
        // Pin shows while any checked message is unpinned (or nothing is checked).
        ...(!selection.pinDisabled || selection.unpinDisabled
          ? [
              {
                kind: "action" as const,
                id: "pin-selected",
                label: strings.mail.pinSelected,
                icon: Pin,
                disabled: selectionDisabled || selection.pinDisabled,
                onSelect: selection.onPin,
              },
            ]
          : []),
        // Unpin shows while any checked message is pinned.
        ...(!selection.unpinDisabled
          ? [
              {
                kind: "action" as const,
                id: "unpin-selected",
                label: strings.mail.unpinSelected,
                icon: PinOff,
                disabled: selectionDisabled || selection.unpinDisabled,
                onSelect: selection.onUnpin,
              },
            ]
          : []),
        selection.mailboxRole === "junk"
          ? {
              kind: "action" as const,
              id: "not-junk",
              label: strings.reader.notJunk,
              icon: Inbox,
              disabled: selectionDisabled,
              onSelect: selection.onNotJunk,
            }
          : {
              kind: "action" as const,
              id: "junk",
              label: strings.reader.junk,
              icon: ShieldAlert,
              disabled: selectionDisabled,
              onSelect: selection.onJunk,
            },
        ...(selection.moveDestinations.length > 0
          ? [
              {
                kind: "submenu" as const,
                id: "bulk-move",
                label: strings.contextMenu.moveTo,
                entries: selection.moveDestinations.map((mailbox) => ({
                  kind: "action" as const,
                  id: `bulk-move-${mailbox.id}`,
                  label: mailbox.name,
                  icon: folderIcons[mailbox.role],
                  ariaLabel: strings.contextMenu.moveToFolder(mailbox.name),
                  disabled: selectionDisabled,
                  onSelect: () => selection.onMoveTo(mailbox.id),
                })),
              },
              {
                kind: "submenu" as const,
                id: "bulk-copy",
                label: strings.contextMenu.copyTo,
                entries: selection.moveDestinations.map((mailbox) => ({
                  kind: "action" as const,
                  id: `bulk-copy-${mailbox.id}`,
                  label: mailbox.name,
                  icon: folderIcons[mailbox.role],
                  ariaLabel: strings.contextMenu.copyToFolder(mailbox.name),
                  disabled: selectionDisabled,
                  onSelect: () => selection.onCopyTo(mailbox.id),
                })),
              },
            ]
          : []),
        {
          kind: "action",
          id: "save-files",
          label: strings.reader.saveSelectedFiles,
          icon: Download,
          disabled: selectionDisabled || selection.saveFilesDisabled,
          onSelect: selection.onSaveFiles,
        },
        {
          kind: "action",
          id: "save-messages",
          label: strings.reader.saveSelectedMessages,
          icon: FileDown,
          disabled: selectionDisabled,
          onSelect: selection.onSaveMessages,
        },
        {
          kind: "action",
          id: "print-selected",
          label: strings.reader.printSelected,
          icon: Printer,
          disabled: selectionDisabled,
          onSelect: selection.onPrint,
        },
        {
          kind: "action",
          id: "copy-selected",
          label: strings.reader.copySelectedText,
          icon: Copy,
          disabled: selectionDisabled,
          onSelect: selection.onCopyText,
        },
        {
          kind: "action",
          id: "forward-selected",
          label: strings.reader.forwardSelected,
          icon: Forward,
          disabled: selectionDisabled,
          onSelect: selection.onForward,
        },
        {
          kind: "action",
          id: "snooze-selected",
          label: strings.mail.snoozeSelected,
          icon: Clock,
          disabled: selectionDisabled,
          onSelect: selection.onSnooze,
        },
        { kind: "separator" },
      ]
    : [];
  const conversationEntries: PopupEntry[] =
    onExpandConversations && onCollapseConversations
      ? [
          {
            kind: "action",
            id: "expand-conversations",
            label: strings.mail.expandConversations,
            icon: ChevronsUpDown,
            disabled: bulkBusy,
            onSelect: onExpandConversations,
          },
          {
            kind: "action",
            id: "collapse-conversations",
            label: strings.mail.collapseConversations,
            icon: ChevronsDownUp,
            disabled: bulkBusy,
            onSelect: onCollapseConversations,
          },
          { kind: "separator" },
        ]
      : [];
  const navEntries: PopupEntry[] = [
    {
      kind: "action",
      id: "go-to-inbox",
      label: strings.mail.goToInbox,
      icon: Inbox,
      disabled: goToInboxDisabled || bulkBusy,
      onSelect: onGoToInbox,
    },
    {
      kind: "action",
      id: "go-to-sent",
      label: strings.mail.goToSent,
      icon: Send,
      disabled: goToSentDisabled || bulkBusy,
      onSelect: onGoToSent,
    },
    {
      kind: "action",
      id: "next-unread",
      label: strings.mail.nextUnread,
      icon: Mail,
      disabled: nextUnreadDisabled || bulkBusy,
      onSelect: onNextUnread,
    },
    {
      kind: "action",
      id: "next-unread-mailbox",
      label: strings.mail.nextUnreadMailbox,
      icon: Inbox,
      disabled: nextUnreadMailboxDisabled || bulkBusy,
      onSelect: onNextUnreadMailbox,
    },
    {
      kind: "action",
      id: "previous-unread-mailbox",
      label: strings.mail.previousUnreadMailbox,
      icon: Inbox,
      disabled: previousUnreadMailboxDisabled || bulkBusy,
      onSelect: onPreviousUnreadMailbox,
    },
    {
      kind: "action",
      id: "mark-all-read",
      label: strings.mail.markAllRead,
      icon: MailOpen,
      disabled: bulkBusy,
      onSelect: onMarkAllRead,
    },
  ];
  const moreEntries: PopupEntry[] = [
    ...(!submittedQuery && !(selecting && selection) ? sortEntries : []),
    ...selectionEntries,
    ...conversationEntries,
    ...navEntries,
  ];
  // Mailbox More is fixed-placed too: the pane clips absolute menus.
  useLayoutEffect(() => {
    if (!mailboxMoreOpen) return;
    const root = mailboxMoreRef.current;
    const trigger = root?.querySelector<HTMLElement>(
      "button[aria-haspopup='menu']",
    );
    const menu = root?.querySelector<HTMLElement>("#mailbox-more-menu");
    if (!trigger || !menu) return;
    const update = () => placeAnchoredMenu(menu, trigger);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [mailboxMoreOpen, mailboxMoreRef]);
  return (
    <>
      <div className="pane-heading">
        <span>
          {accountLabel ? <p className="pane-account">{accountLabel}</p> : null}
          <h1>{heading}</h1>
          <small>
            {selecting && selection
              ? strings.mail.selectedCount(selection.count)
              : [
                  unreadCount ? strings.mail.unreadCount(unreadCount) : null,
                  folderTotal != null &&
                  folderTotal > shownCount &&
                  shownCount > 0
                    ? strings.mail.loadedOfTotal(shownCount, folderTotal)
                    : strings.mail.itemCount(shownCount),
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </small>
        </span>
        <div className="pane-heading-actions">
          {activeLocalView ? localAction : null}
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
                  <Ellipsis aria-hidden="true" />
                </button>
                {mailboxMoreOpen ? (
                  <div
                    id="mailbox-more-menu"
                    className="mailbox-more-menu app-menu"
                    role="menu"
                    aria-label={strings.mail.moreMailboxActions}
                    onKeyDown={moveMenuFocus}
                    onScroll={(event) => syncScrollCue(event.currentTarget)}
                  >
                    <PopupEntries entries={moreEntries} />
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
      {/* Select mode swaps this band for the bulk bar in the same slot. */}
      {!activeLocalView && !submittedQuery && !selecting ? (
        <div className="mailbox-filter">
          <div className="mailbox-filter-control">
            <div
              className="mailbox-filter-segments"
              role="radiogroup"
              aria-label={strings.mail.showMessages}
            >
              {primaryFilters.map((filter) => (
                <label key={filter.id} className="mailbox-filter-segment">
                  <input
                    type="radio"
                    name="mailbox-filter"
                    checked={listFilter === filter.id}
                    onChange={() => onListFilter(filter.id)}
                  />
                  <span>{filter.label}</span>
                </label>
              ))}
            </div>
            <div className="mailbox-filter-more" ref={filterMenuRef}>
              <button
                type="button"
                className={`mailbox-filter-segment${activeMore ? " checked" : ""}`}
                onClick={() => setFilterMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setFilterMenuOpen(true);
                  }
                }}
                aria-haspopup="menu"
                aria-expanded={filterMenuOpen}
                aria-controls="mailbox-filter-menu"
                aria-label={
                  activeMore
                    ? strings.mail.moreFiltersActive(activeMore.label)
                    : strings.mail.moreFilters
                }
              >
                <span>
                  {activeMore ? activeMore.label : strings.mail.filterMore}
                </span>
                <ChevronDown aria-hidden="true" />
              </button>
              {filterMenuOpen ? (
                <div
                  id="mailbox-filter-menu"
                  className="mailbox-filter-menu app-menu"
                  role="menu"
                  aria-label={strings.mail.moreFilters}
                  onKeyDownCapture={moveMenuFocus}
                >
                  {moreFilters.map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={listFilter === filter.id}
                      onClick={() => {
                        onListFilter(filter.id);
                        setFilterMenuOpen(false);
                        filterMenuRef.current
                          ?.querySelector<HTMLElement>(
                            "button[aria-haspopup='menu']",
                          )
                          ?.focus();
                      }}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
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
      <button type="button" disabled={disabled} onClick={onArchive}>
        <Archive aria-hidden="true" /> {archiveLabel}
      </button>
      <button type="button" disabled={disabled} onClick={onTrash}>
        <Trash aria-hidden="true" /> {trashLabel}
      </button>
    </div>
  );
}
