import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  ArrowDown,
  CalendarDays,
  CircleAlert,
  Forward,
  Paperclip,
  Pin,
  Reply,
  Star,
} from "lucide-react";
import {
  createListDateFormatters,
  formatBytes,
  formatFullMessageDate,
  formatMessageListWhen,
  groupByDayLabel,
  messageListDay,
  notableArrival,
  type ListDateFormatters,
} from "../../format";
import { addressMailbox } from "../../contextMenu";
import { strings } from "../../i18n";
import { rememberListScroll, rememberedListScroll } from "../../listScroll";
import {
  rememberedExpandedThreads,
  rememberExpandedThreads,
} from "../../threadExpand";
import { folderPathLabel } from "../../i18n/mail";
import {
  MESSAGE_DRAG_TYPE,
  beginMessageDrag,
  endMessageDrag,
  messageDragPayload,
} from "../../messageDrag";
import { HighlightedText } from "../HighlightedText";
import { RowActions } from "./rowActions";
import { highlightTerms } from "../../searchHighlight";
import { useAppStore } from "../../store";
import { groupThreads, pinnedFirst } from "../../threads";
import type { MessageSummary } from "../../types";

function MessageWhen({
  message,
  now,
  formatters,
}: {
  message: MessageSummary;
  now: Date;
  formatters: ListDateFormatters;
}) {
  const late = notableArrival(message.receivedAt, message.arrivedAt);
  return (
    <span className="message-when">
      <time
        className="message-date"
        dateTime={message.receivedAt}
        title={formatFullMessageDate(message.receivedAt, now, formatters)}
      >
        {formatMessageListWhen(message.receivedAt, now, formatters)}
      </time>
      <span className="message-size">{formatBytes(message.size)}</span>
      {late ? (
        <span className="message-arrived">{strings.mail.arrivedLater}</span>
      ) : null}
    </span>
  );
}

function ImportanceMark({ importance }: { importance?: string }) {
  if (importance === "high") {
    return (
      <CircleAlert
        className="message-mark importance-high"
        aria-hidden="true"
      />
    );
  }
  if (importance === "low") {
    return (
      <ArrowDown className="message-mark importance-low" aria-hidden="true" />
    );
  }
  return null;
}

type VisibleOption = {
  key: string;
  kind: "header" | "message";
  message: MessageSummary;
  groupKey?: string;
};

type ThreadGroup = ReturnType<typeof groupThreads>[number];

// One day-grouped unit: a solo row, or a whole conversation with its children.
type ListEntry = {
  key: string;
  day: string;
  ids: number[];
  options: VisibleOption[];
};

// One line of the virtual list: a day heading or an option.
type VirtualItem =
  | {
      kind: "day";
      key: string;
      label: string;
      count: number;
      ids: number[];
      first: boolean;
    }
  | { kind: "option"; key: string; option: VisibleOption; groupEnd: boolean };

// Estimates until measureElement reports real heights.
const DAY_ESTIMATE = 36;
const ROW_ESTIMATE = 84;

// Stacks every item by estimate; used until the list has a height.
function estimatedRows(items: VirtualItem[]) {
  let start = 0;
  return items.map((item, index) => {
    const row = { index, key: item.key, start };
    start += item.kind === "day" ? DAY_ESTIMATE : ROW_ESTIMATE;
    return row;
  });
}

// Finds a mounted option by key. Thread keys hold angle brackets, so a CSS
// attribute selector would need escaping; comparing dataset values does not.
function mountedOption(
  root: HTMLElement | null,
  key: string,
): HTMLElement | undefined {
  return Array.from(
    root?.querySelectorAll<HTMLElement>("[data-option-key]") ?? [],
  ).find((element) => element.dataset.optionKey === key);
}

export function MessageList({
  messages,
  selectedId,
  loading,
  loadingMessageId,
  onChoose,
  hasMore,
  onLoadMore,
  loadMoreLabel,
  searchQuery,
  showFolders = false,
  onClearSearch,
  onSearchAllFolders,
  emptyLabel,
  selecting,
  selectedIds,
  onToggleSelect,
  onCheckFocused,
  onArchiveFocused,
  onTrashFocused,
  onJunkFocused,
  onReplyFocused,
  onRangeSelect,
  onToggleStar,
  onToggleConversationStar,
  onToggleRead,
  onToggleConversationRead,
  onSelectDay,
  chronological = true,
  oldestFirst = false,
  scrollKey,
}: {
  messages: MessageSummary[];
  selectedId?: number;
  loading: boolean;
  loadingMessageId?: number;
  onChoose: (message: MessageSummary) => Promise<void>;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  /** Overrides the button text, e.g. when older mail comes from the server. */
  loadMoreLabel?: string;
  searchQuery?: string;
  /** Account-wide search mixes folders, so each row names its mailbox. */
  showFolders?: boolean;
  onClearSearch?: () => void;
  /** Widen a mailbox search that found nothing. */
  onSearchAllFolders?: () => void;
  emptyLabel?: string;
  selecting?: boolean;
  selectedIds?: number[];
  onToggleSelect?: (id: number) => void;
  /** Check or uncheck the focused row, or a whole loaded conversation. */
  onCheckFocused?: (ids: number[]) => void;
  /** Archive the focused row, or every loaded message in a conversation. */
  onArchiveFocused?: (message: MessageSummary, conversation: boolean) => void;
  /** Move the focused row to Trash, or delete it when it is already there. */
  onTrashFocused?: (message: MessageSummary, conversation: boolean) => void;
  /** Mark the focused row as junk, or move it to Inbox when it is already junk. */
  onJunkFocused?: (message: MessageSummary, conversation: boolean) => void;
  /** Reply, or reply all, to the focused row without opening it first. */
  onReplyFocused?: (
    message: MessageSummary,
    mode: "reply" | "replyAll",
  ) => void;
  onRangeSelect?: (targetId: number, fallbackAnchorId?: number) => void;
  /** Star or unstar one row without opening it. */
  onToggleStar?: (message: MessageSummary) => void;
  /** Star or unstar every loaded message in a conversation. */
  onToggleConversationStar?: (
    message: MessageSummary,
    starred: boolean,
  ) => void;
  /** Mark one row read or unread without opening it. */
  onToggleRead?: (message: MessageSummary) => void;
  /** Mark every loaded message in a conversation read, or unread when none are unread. */
  onToggleConversationRead?: (message: MessageSummary, isRead: boolean) => void;
  /** Check every loaded message grouped under this day heading. */
  onSelectDay?: (ids: number[]) => void;
  /** Date order can group conversations and days. Other orders stay in page order. */
  chronological?: boolean;
  /** Oldest-first date order keeps day headings and leaves conversations ungrouped. */
  oldestFirst?: boolean;
  /** Remembers the scroll place for this folder or list. */
  scrollKey?: string;
}) {
  const groupThreadsSetting = useAppStore(
    (state) => state.settings.groupThreads,
  );
  const showMessagePreviews = useAppStore(
    (state) => state.settings.showMessagePreviews,
  );
  const mailboxes = useAppStore((state) => state.mailboxes);
  const accounts = useAppStore((state) => state.accounts);
  function sentByYou(message: MessageSummary): boolean {
    const account = accounts.find((item) => item.id === message.accountId);
    if (!account) return false;
    const address = addressMailbox(message.senderAddress)?.toLowerCase();
    if (!address) return false;
    return [account.email, ...(account.aliases ?? [])].some(
      (item) => addressMailbox(item)?.toLowerCase() === address,
    );
  }
  function folderName(message: MessageSummary): string | undefined {
    if (!showFolders) return undefined;
    const mailbox = mailboxes.find((box) => box.id === message.mailboxId);
    const label = mailbox ? folderPathLabel(mailbox).trim() : "";
    return label || undefined;
  }

  function correspondent(message: MessageSummary): string {
    const role = mailboxes.find((box) => box.id === message.mailboxId)?.role;
    if (role === "sent" || role === "drafts") {
      const people = message.recipients
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (people.length === 0) return strings.mail.noRecipient;
      return strings.mail.toPeople(people.join(", "));
    }
    if (sentByYou(message)) return strings.mail.you;
    return message.senderName || message.senderAddress;
  }
  function conversationPeople(group: { items: MessageSummary[] }): string {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const item of group.items) {
      const name = correspondent(item);
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    if (names.length <= 3) return names.join(", ");
    return strings.mail.peopleAndMore(names[0], names[1], names.length - 2);
  }
  function senderAddressTitle(message: MessageSummary): string | undefined {
    const role = mailboxes.find((box) => box.id === message.mailboxId)?.role;
    if (role === "sent" || role === "drafts") return undefined;
    const address = message.senderAddress.trim();
    if (!address) return undefined;
    if (sentByYou(message)) return address;
    const name = message.senderName.trim();
    if (name.toLowerCase() === address.toLowerCase()) return undefined;
    return address;
  }
  const groupConversations =
    groupThreadsSetting && chronological && !oldestFirst;
  // One batch of Intl formatters shared by every row and day label in this
  // render; labels still recompute from a fresh `now` each render.
  const dateFormatters = useMemo(() => createListDateFormatters(), []);
  const listNow = new Date();
  const listRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  useLayoutEffect(() => {
    restoredScroll.current = false;
  }, [scrollKey]);
  const [expandedThreads, setExpandedThreads] = useState<string[]>(() =>
    scrollKey ? rememberedExpandedThreads(scrollKey) : [],
  );
  const updateExpanded = useCallback(
    (next: string[] | ((current: string[]) => string[])) => {
      setExpandedThreads((current) => {
        const value = typeof next === "function" ? next(current) : next;
        if (scrollKey) rememberExpandedThreads(scrollKey, value);
        return value;
      });
    },
    [scrollKey],
  );
  const [focusedOptionKey, setFocusedOptionKey] = useState<string>();
  // Focus waiting for its row to mount, the dragged row, and the selection
  // anchor. The virtualizer keeps all three mounted.
  const [pendingFocusKey, setPendingFocusKey] = useState<string>();
  const [dragKey, setDragKey] = useState<string>();
  const [anchorId, setAnchorId] = useState<number>();
  const [newAtTop, setNewAtTop] = useState(false);
  const seenRef = useRef<{ ids: Set<number>; newest: number } | null>(null);
  const marks = highlightTerms(searchQuery ?? "");

  useEffect(() => {
    const newest = messages.reduce((max, message) => {
      const time = Date.parse(message.receivedAt);
      return Number.isNaN(time) ? max : Math.max(max, time);
    }, 0);
    const ids = new Set(messages.map((message) => message.id));
    const previous = seenRef.current;
    seenRef.current = { ids, newest };
    if (!previous || searchQuery) {
      setNewAtTop(false);
      return;
    }
    const added = messages.filter((message) => !previous.ids.has(message.id));
    const kept = messages.some((message) => previous.ids.has(message.id));
    if (!kept || added.length === 0) return;
    const addedNewest = added.reduce((max, message) => {
      const time = Date.parse(message.receivedAt);
      return Number.isNaN(time) ? max : Math.max(max, time);
    }, 0);
    if (addedNewest < previous.newest) return;
    if ((listRef.current?.scrollTop ?? 0) < 48) return;
    setNewAtTop(true);
  }, [messages, searchQuery]);

  function toggleThread(key: string) {
    updateExpanded((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  }

  useEffect(() => {
    const expand = () => {
      if (!groupConversations || selecting) return;
      updateExpanded(
        groupThreads(messages)
          .filter((group) => group.items.length > 1)
          .map((group) => group.key),
      );
    };
    const collapse = () => {
      if (!groupConversations || selecting) return;
      updateExpanded([]);
    };
    window.addEventListener("postal:expand-conversations", expand);
    window.addEventListener("postal:collapse-conversations", collapse);
    return () => {
      window.removeEventListener("postal:expand-conversations", expand);
      window.removeEventListener("postal:collapse-conversations", collapse);
    };
  }, [groupConversations, messages, selecting, updateExpanded]);

  // A row picked with the pointer is already in view; scrolling it would
  // close a context menu that the same click opened.
  const pointerPick = useRef(false);

  // The open message's thread stays expanded without storing it:
  // deriving keeps render pure and survives list reloads.
  const groupedThreads =
    groupConversations && !selecting ? groupThreads(messages) : [];
  const selectedThreadKey = selectedId
    ? groupedThreads.find(
        (group) =>
          group.items.length > 1 &&
          group.items.some((item) => item.id === selectedId),
      )?.key
    : undefined;
  const effectiveExpanded =
    selectedThreadKey && !expandedThreads.includes(selectedThreadKey)
      ? [...expandedThreads, selectedThreadKey]
      : expandedThreads;
  // Conversation headers expand, which listbox options cannot express. Use a
  // tree only when a real thread renders; flat lists keep listbox semantics.
  const hasThreadedGroups = groupedThreads.some(
    (group) => group.items.length > 1,
  );
  const rowRole = hasThreadedGroups ? "treeitem" : "option";
  const threadsById = new Map<string, ThreadGroup>(
    groupedThreads.map((group): [string, ThreadGroup] => [group.key, group]),
  );

  function threadOptions(group: ThreadGroup): VisibleOption[] {
    if (group.items.length === 1) {
      return [
        {
          key: `message:${group.newest.id}`,
          kind: "message",
          message: group.newest,
        },
      ];
    }
    const options: VisibleOption[] = [
      {
        key: `thread:${group.key}`,
        kind: "header",
        message: group.newest,
        groupKey: group.key,
      },
    ];
    if (effectiveExpanded.includes(group.key)) {
      options.push(
        ...group.items.map((message) => ({
          key: `message:${message.id}`,
          kind: "message" as const,
          message,
          groupKey: group.key,
        })),
      );
    }
    return options;
  }

  const orderedMessages = pinnedFirst(messages);
  const listEntries: ListEntry[] =
    groupedThreads.length > 0
      ? groupedThreads.map((group) => ({
          key: group.key,
          day: searchQuery
            ? ""
            : group.items.some((item) => item.pinned)
              ? strings.mail.pinned
              : messageListDay(
                  group.newest.receivedAt,
                  listNow,
                  dateFormatters,
                ),
          ids: group.items.map((item) => item.id),
          options: threadOptions(group),
        }))
      : orderedMessages.map((message) => ({
          key: `message:${message.id}`,
          day: searchQuery
            ? ""
            : message.pinned
              ? strings.mail.pinned
              : chronological
                ? messageListDay(message.receivedAt, listNow, dateFormatters)
                : "",
          ids: [message.id],
          options: [
            {
              key: `message:${message.id}`,
              kind: "message" as const,
              message,
            },
          ],
        }));
  const visibleOptions = listEntries.flatMap((entry) => entry.options);

  const selectedOptionKey = selectedId
    ? (visibleOptions.find(
        (option) =>
          option.kind === "header" && option.message.id === selectedId,
      )?.key ?? `message:${selectedId}`)
    : undefined;
  const activeOptionKey = visibleOptions.some(
    (option) => option.key === focusedOptionKey,
  )
    ? focusedOptionKey
    : selectedOptionKey &&
        visibleOptions.some((option) => option.key === selectedOptionKey)
      ? selectedOptionKey
      : visibleOptions[0]?.key;

  // Flatten day headings and options into the list the virtualizer windows.
  const daySections = groupByDayLabel(listEntries, (entry) =>
    searchQuery || !chronological ? "" : entry.day,
  );
  const items: VirtualItem[] = [];
  daySections.forEach((section, sectionIndex) => {
    if (section.label) {
      items.push({
        kind: "day",
        key: `day:${sectionIndex}`,
        label: section.label,
        count: section.items.reduce((sum, entry) => sum + entry.ids.length, 0),
        ids: section.items.flatMap((entry) => entry.ids),
        first: sectionIndex === 0,
      });
    }
    for (const entry of section.items) {
      entry.options.forEach((option, position) => {
        items.push({
          kind: "option",
          key: option.key,
          option,
          groupEnd:
            entry.options.length > 1 && position === entry.options.length - 1,
        });
      });
    }
  });
  const itemIndex = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind === "option") itemIndex.set(item.key, index);
  });
  const optionPosition = new Map<string, number>(
    visibleOptions.map((option, index): [string, number] => [
      option.key,
      index + 1,
    ]),
  );
  const anchorKey =
    anchorId === undefined
      ? undefined
      : visibleOptions.find((option) => option.message.id === anchorId)?.key;

  // Keyboard focus, the roving tab stop, a pending focus move, the drag
  // source, the anchor, and the first and last checked rows stay mounted.
  const pinnedIndexes: number[] = [
    activeOptionKey,
    focusedOptionKey,
    pendingFocusKey,
    dragKey,
    selectedOptionKey,
    anchorKey,
  ].flatMap((key) => {
    const index = key === undefined ? undefined : itemIndex.get(key);
    return index === undefined ? [] : [index];
  });
  if (selecting && selectedIds && selectedIds.length > 0) {
    const chosen = new Set(selectedIds);
    let first = -1;
    let last = -1;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.kind !== "option" || !chosen.has(item.option.message.id)) {
        continue;
      }
      if (first < 0) first = index;
      last = index;
    }
    if (first >= 0) pinnedIndexes.push(first, last);
  }

  // The virtualizer is read during render; this component is not memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer: Virtualizer<HTMLDivElement, Element> = useVirtualizer<
    HTMLDivElement,
    Element
  >({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) =>
      items[index]?.kind === "day" ? DAY_ESTIMATE : ROW_ESTIMATE,
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 8,
    initialRect: { width: 0, height: 800 },
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...pinnedIndexes])].sort(
        (a, b) => a - b,
      ),
  });

  // Restores the remembered place only after the virtualizer has a viewport;
  // earlier, its own offset would reset the scroll.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scrollKey || restoredScroll.current || !laidOut) return;
    const top = rememberedListScroll(scrollKey);
    if (top <= 0) {
      restoredScroll.current = true;
      return;
    }
    if (list.scrollHeight <= list.clientHeight) return;
    virtualizer.scrollToOffset(top);
    restoredScroll.current = true;
  });

  // Moves focus to a row once it is mounted; the next render mounts it.
  // Without a viewport (tests, a collapsed pane) the virtualizer has no range,
  // so rows stack by estimate and all mount.
  const laidOut = (virtualizer.scrollRect?.height ?? 0) > 0;
  const renderedRows = laidOut
    ? virtualizer.getVirtualItems()
    : estimatedRows(items);
  const pendingMounted =
    pendingFocusKey !== undefined && itemIndex.has(pendingFocusKey);
  useLayoutEffect(() => {
    if (pendingFocusKey === undefined) return;
    const element = mountedOption(listRef.current, pendingFocusKey);
    if (element) {
      element.focus();
      setPendingFocusKey(undefined);
    } else if (!pendingMounted) {
      setPendingFocusKey(undefined);
    }
  }, [pendingFocusKey, pendingMounted, renderedRows]);

  const selectionTarget = useRef<{ key?: string; index?: number }>({});
  useLayoutEffect(() => {
    selectionTarget.current = {
      key: selectedOptionKey,
      index:
        selectedOptionKey === undefined
          ? undefined
          : itemIndex.get(selectedOptionKey),
    };
  });
  // Brings the open row into view when the selection changes, then focuses it
  // if focus is already in the list.
  useEffect(() => {
    const { key, index } = selectionTarget.current;
    const fromPointer = pointerPick.current;
    pointerPick.current = false;
    if (key === undefined || index === undefined) return;
    if (!fromPointer) virtualizer.scrollToIndex(index, { align: "auto" });
    if (!listRef.current?.contains(document.activeElement)) return;
    const element = mountedOption(listRef.current, key);
    if (element) element.focus();
    else setPendingFocusKey(key);
  }, [selectedId, virtualizer]);

  if (loading && messages.length === 0)
    return (
      <div className="list-state" role="status">
        {strings.mail.loadingMessages}
      </div>
    );
  if (messages.length === 0) {
    if (searchQuery) {
      return (
        <div className="list-state" role="status">
          <p>{strings.mail.noSearchResults(searchQuery)}</p>
          {onSearchAllFolders || onClearSearch ? (
            <div className="list-state-actions">
              {onSearchAllFolders ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onSearchAllFolders}
                >
                  {strings.mail.searchAllMailboxes}
                </button>
              ) : null}
              {onClearSearch ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onClearSearch}
                >
                  {strings.mail.clearSearch}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <div className="list-state" role="status" aria-live="polite">
        {emptyLabel ?? strings.mail.emptyMailbox}
      </div>
    );
  }

  // Scrolls the row into the virtual window first, then focuses it.
  function focusOption(option: VisibleOption) {
    const index = itemIndex.get(option.key);
    if (index === undefined) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    const element = mountedOption(listRef.current, option.key);
    if (element) element.focus();
    else setPendingFocusKey(option.key);
  }

  // Checks and day selections anchor range selection on their first id,
  // as the mailbox selection does.
  function pickRow(id: number) {
    setAnchorId(id);
    onToggleSelect?.(id);
  }
  function checkIds(ids: number[]) {
    if (ids.length > 0) setAnchorId(ids[0]);
    onCheckFocused?.(ids);
  }
  function pickDay(ids: number[]) {
    if (ids.length > 0) setAnchorId(ids[0]);
    onSelectDay?.(ids);
  }

  function toggleStarFor(option: VisibleOption) {
    if (option.kind === "header" && option.groupKey) {
      const group = threadsById.get(option.groupKey);
      if (group && group.items.length > 1) {
        const starred = group.items.some((item) => item.isStarred);
        onToggleConversationStar?.(group.newest, !starred);
        return;
      }
    }
    onToggleStar?.(option.message);
  }

  function toggleReadFor(option: VisibleOption) {
    if (option.kind === "header" && option.groupKey) {
      const group = threadsById.get(option.groupKey);
      if (group && group.items.length > 1) {
        onToggleConversationRead?.(group.newest, group.unread > 0);
        return;
      }
    }
    onToggleRead?.(option.message);
  }

  function rowActions(
    message: MessageSummary,
    conversation: boolean,
    starred: boolean,
    unread: boolean,
  ) {
    if (selecting) return null;
    const role = mailboxes.find((box) => box.id === message.mailboxId)?.role;
    return (
      <RowActions
        message={message}
        conversation={conversation}
        starred={starred}
        unread={unread}
        fromArchive={role === "archive"}
        inTrash={role === "trash"}
        onStar={
          onToggleStar
            ? () => {
                if (conversation) onToggleConversationStar?.(message, !starred);
                else onToggleStar(message);
              }
            : undefined
        }
        onRead={
          onToggleRead
            ? () => {
                if (conversation) onToggleConversationRead?.(message, unread);
                else onToggleRead(message);
              }
            : undefined
        }
        onArchive={onArchiveFocused}
        onTrash={onTrashFocused}
      />
    );
  }

  function handleOptionKeyDown(
    event: React.KeyboardEvent<HTMLElement>,
    optionKey: string,
  ) {
    const option = visibleOptions.find((item) => item.key === optionKey);
    if (hasThreadedGroups) {
      if (
        event.key === "ArrowRight" &&
        option?.kind === "header" &&
        option.groupKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!effectiveExpanded.includes(option.groupKey)) {
          toggleThread(option.groupKey);
          return;
        }
        const firstChild = visibleOptions.find(
          (item) =>
            item.kind === "message" && item.groupKey === option.groupKey,
        );
        if (firstChild) focusOption(firstChild);
        return;
      }
      if (event.key === "ArrowLeft") {
        if (
          option?.kind === "header" &&
          option.groupKey &&
          expandedThreads.includes(option.groupKey)
        ) {
          event.preventDefault();
          event.stopPropagation();
          toggleThread(option.groupKey);
          return;
        }
        if (option?.kind === "message" && option.groupKey) {
          event.preventDefault();
          event.stopPropagation();
          const header = visibleOptions.find(
            (item) => item.key === `thread:${option.groupKey}`,
          );
          if (header) focusOption(header);
          return;
        }
      }
    }
    if (
      (event.key === "r" || event.key === "a") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      option &&
      onReplyFocused
    ) {
      event.preventDefault();
      event.stopPropagation();
      const message =
        option.kind === "header" && option.groupKey
          ? (threadsById.get(option.groupKey)?.newest ?? option.message)
          : option.message;
      onReplyFocused(message, event.key === "a" ? "replyAll" : "reply");
      return;
    }
    if (
      event.key === "!" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      option &&
      onJunkFocused
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (option.kind === "header" && option.groupKey) {
        const group = threadsById.get(option.groupKey);
        if (group && group.items.length > 1) {
          onJunkFocused(group.newest, true);
          return;
        }
      }
      onJunkFocused(option.message, false);
      return;
    }
    if (
      (event.key === "Delete" || event.key === "#") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      option &&
      onTrashFocused
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (option.kind === "header" && option.groupKey) {
        const group = threadsById.get(option.groupKey);
        if (group && group.items.length > 1) {
          onTrashFocused(group.newest, true);
          return;
        }
      }
      onTrashFocused(option.message, false);
      return;
    }
    if (
      event.key === "e" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      option &&
      onArchiveFocused
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (option.kind === "header" && option.groupKey) {
        const group = threadsById.get(option.groupKey);
        if (group && group.items.length > 1) {
          onArchiveFocused(group.newest, true);
          return;
        }
      }
      onArchiveFocused(option.message, false);
      return;
    }
    if (
      event.key === "x" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      option &&
      onCheckFocused
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (option.kind === "header" && option.groupKey) {
        const group = threadsById.get(option.groupKey);
        if (group && group.items.length > 1) {
          checkIds(group.items.map((item) => item.id));
          return;
        }
      }
      checkIds([option.message.id]);
      return;
    }
    if (
      event.key === "s" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !selecting &&
      option &&
      onToggleStar
    ) {
      event.preventDefault();
      event.stopPropagation();
      toggleStarFor(option);
      return;
    }
    if (
      event.key === "u" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !selecting &&
      option &&
      onToggleRead
    ) {
      event.preventDefault();
      event.stopPropagation();
      toggleReadFor(option);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = visibleOptions.findIndex(
      (option) => option.key === optionKey,
    );
    if (index < 0) return;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visibleOptions.length - 1
          : Math.max(
              0,
              Math.min(
                visibleOptions.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
    const next = visibleOptions[nextIndex];
    if (!next || next.key === optionKey) return;
    focusOption(next);
    if (
      selecting &&
      event.shiftKey &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      onRangeSelect?.(next.message.id, visibleOptions[index]?.message.id);
      return;
    }
    if (!selecting) void onChoose(next.message);
  }

  function dragIds(
    message: MessageSummary,
    wholeConversation = false,
  ): number[] {
    const chosen = selectedIds ?? [];
    if (selecting && chosen.includes(message.id)) return chosen;
    if (wholeConversation) {
      const group = groupedThreadFor(message.id);
      if (group && group.items.length > 1) {
        return group.items.map((row) => row.id);
      }
    }
    return [message.id];
  }

  function groupedThreadFor(messageId: number) {
    return groupedThreads.find((item) =>
      item.items.some((row) => row.id === messageId),
    );
  }

  function messageDragProps(
    message: MessageSummary,
    wholeConversation: boolean,
    optionKey: string,
  ) {
    return {
      draggable: true as const,
      onDragStart: (event: DragEvent<HTMLButtonElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          MESSAGE_DRAG_TYPE,
          messageDragPayload(
            message.accountId,
            dragIds(message, wholeConversation),
          ),
        );
        beginMessageDrag();
        setDragKey(optionKey);
      },
      onDragEnd: () => {
        endMessageDrag();
        setDragKey(undefined);
      },
    };
  }

  function renderRow(
    message: MessageSummary,
    optionKey: string,
    groupKey?: string,
    treeLevel?: number,
    groupEnd = false,
  ) {
    const checked = selecting && (selectedIds ?? []).includes(message.id);
    const isNewestThreadChild =
      !selecting &&
      groupKey !== undefined &&
      groupedThreads.some(
        (group) => group.key === groupKey && group.newest.id === message.id,
      );
    const isSelected = selecting
      ? checked
      : selectedId === message.id && !isNewestThreadChild;
    const folder = folderName(message);
    const rowLabel = [
      message.isRead ? strings.mail.read : strings.mail.unread,
      message.isStarred ? strings.mail.starred : null,
      message.pinned ? strings.mail.pinned : null,
      correspondent(message),
      senderAddressTitle(message),
      message.subject || strings.common.noSubject,
      folder ? strings.mail.inFolder(folder) : null,
      formatFullMessageDate(message.receivedAt, listNow, dateFormatters),
      formatBytes(message.size),
      message.attachmentCount
        ? strings.mail.draftFiles(message.attachmentCount)
        : message.hasAttachments
          ? strings.mail.hasAttachments
          : null,
      message.importance === "high"
        ? strings.mail.highImportance
        : message.importance === "low"
          ? strings.mail.lowImportance
          : null,
      message.hasCalendar ? strings.mail.hasInvitation : null,
      message.isAnswered ? strings.mail.replied : null,
      message.isForwarded ? strings.mail.forwarded : null,
      message.conversationMuted ? strings.mail.muted : null,
      notableArrival(message.receivedAt, message.arrivedAt)
        ? strings.mail.arrivedLater
        : null,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <div
        className={`message-row-wrap${groupKey !== undefined ? " thread-child" : ""}${groupEnd ? " thread-end" : ""}${!selecting && isSelected ? " selected" : ""}`}
      >
        {selecting ? (
          // A compact checkbox inside a full 44px click target. The listbox
          // owns only options, so the visual checkbox stays out of the
          // accessibility tree; the row button keeps aria-selected and all
          // keyboard selection behavior.
          <label className="message-select-hit" aria-hidden="true">
            <input
              type="checkbox"
              className="message-select"
              checked={checked}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                // Preventing click would undo the native toggle in browsers.
                const shift = (event.nativeEvent as MouseEvent).shiftKey;
                if (shift) onRangeSelect?.(message.id);
                else pickRow(message.id);
              }}
              aria-label={strings.mail.selectMessage(
                message.subject || strings.common.noSubject,
              )}
            />
          </label>
        ) : null}
        <button
          type="button"
          role={rowRole}
          aria-selected={isSelected}
          aria-level={rowRole === "treeitem" ? (treeLevel ?? 1) : undefined}
          aria-posinset={optionPosition.get(optionKey)}
          aria-setsize={visibleOptions.length}
          data-option-key={optionKey}
          data-context="message"
          data-message-id={message.id}
          tabIndex={activeOptionKey === optionKey ? 0 : -1}
          aria-label={rowLabel}
          className={`message-row ${message.isRead ? "read" : "unread"} ${!selecting && isSelected ? "selected" : ""} ${checked ? "checked" : ""}`}
          {...messageDragProps(message, false, optionKey)}
          onClick={(event) => {
            if (!selecting) {
              void onChoose(message);
              return;
            }
            if (event.shiftKey) onRangeSelect?.(message.id);
            else pickRow(message.id);
          }}
          onFocus={() => setFocusedOptionKey(optionKey)}
          onKeyDown={(event) => handleOptionKeyDown(event, optionKey)}
        >
          <span className="unread-dot" aria-hidden="true" />
          <span className="message-sender" title={senderAddressTitle(message)}>
            <HighlightedText
              text={correspondent(message)}
              terms={marks.correspondent}
            />
          </span>
          <MessageWhen
            message={message}
            now={listNow}
            formatters={dateFormatters}
          />
          <span className="message-subject">
            {message.isStarred ? (
              <Star
                className="message-mark star-mark"
                fill="currentColor"
                aria-hidden="true"
              />
            ) : null}
            {folder ? <span className="message-folder">{folder}</span> : null}
            {message.pinned ? (
              <Pin className="message-mark pin-mark" aria-hidden="true" />
            ) : null}
            {message.conversationMuted ? (
              <span className="message-muted">{strings.mail.muted}</span>
            ) : null}
            <span>
              <HighlightedText
                text={message.subject || strings.common.noSubject}
                terms={marks.subject}
              />
            </span>
            {message.attachmentCount ? (
              <span className="message-file-count">
                {strings.mail.draftFiles(message.attachmentCount)}
              </span>
            ) : message.hasAttachments ? (
              <Paperclip aria-hidden="true" />
            ) : null}
            <ImportanceMark importance={message.importance} />
            {message.hasCalendar ? (
              <CalendarDays className="message-mark" aria-hidden="true" />
            ) : null}
            {message.isAnswered ? (
              <Reply className="message-mark" aria-hidden="true" />
            ) : null}
            {message.isForwarded ? (
              <Forward className="message-mark" aria-hidden="true" />
            ) : null}
          </span>
          {showMessagePreviews || loadingMessageId === message.id ? (
            <span className="message-preview">
              {loadingMessageId === message.id ? (
                strings.mail.downloadingMessage
              ) : (
                <HighlightedText
                  text={message.preview || strings.mail.openToDownload}
                  terms={message.preview ? marks.preview : []}
                />
              )}
            </span>
          ) : null}
        </button>
        {rowActions(message, false, message.isStarred, !message.isRead)}
      </div>
    );
  }

  function renderThreadHeader(group: ThreadGroup, groupEnd: boolean) {
    const expanded = effectiveExpanded.includes(group.key);
    const optionKey = `thread:${group.key}`;
    const headerFolder = folderName(group.newest);
    const conversationStarred = group.items.some((item) => item.isStarred);
    const conversationPinned = group.items.some((item) => item.pinned);
    const conversationFiles = group.items.reduce(
      (total, item) => total + (item.attachmentCount ?? 0),
      0,
    );
    const conversationAttachment =
      conversationFiles === 0 &&
      group.items.some((item) => item.hasAttachments);
    const conversationCalendar = group.items.some((item) => item.hasCalendar);
    const conversationReplied = group.items.some((item) => item.isAnswered);
    const conversationForwarded = group.items.some((item) => item.isForwarded);
    const conversationMuted = group.items.some(
      (item) => item.conversationMuted,
    );
    const conversationLate = group.items.some((item) =>
      notableArrival(item.receivedAt, item.arrivedAt),
    );
    const conversationImportance = group.items.some(
      (item) => item.importance === "high",
    )
      ? "high"
      : group.items.some((item) => item.importance === "low")
        ? "low"
        : "";
    return (
      <div
        className={`message-row-wrap thread-header-wrap${group.newest.id === selectedId ? " selected" : ""}${groupEnd ? " thread-end" : ""}`}
      >
        <button
          type="button"
          role="treeitem"
          aria-selected={selectedId === group.newest.id}
          aria-level={1}
          aria-posinset={optionPosition.get(optionKey)}
          aria-setsize={visibleOptions.length}
          data-option-key={optionKey}
          tabIndex={activeOptionKey === optionKey ? 0 : -1}
          className={`message-row thread-header ${group.newest.id === selectedId ? "selected" : ""} ${group.unread > 0 ? "unread" : "read"}`}
          {...messageDragProps(group.newest, true, optionKey)}
          data-context="message"
          data-message-id={group.newest.id}
          aria-expanded={expanded}
          onClick={() => {
            void onChoose(group.newest);
            toggleThread(group.key);
          }}
          aria-label={[
            strings.mail.conversation,
            conversationPeople(group),
            senderAddressTitle(group.newest),
            group.newest.subject || strings.common.noSubject,
            conversationStarred ? strings.mail.starred : null,
            conversationPinned ? strings.mail.pinned : null,
            conversationFiles
              ? strings.mail.draftFiles(conversationFiles)
              : conversationAttachment
                ? strings.mail.hasAttachments
                : null,
            conversationImportance === "high"
              ? strings.mail.highImportance
              : conversationImportance === "low"
                ? strings.mail.lowImportance
                : null,
            conversationCalendar ? strings.mail.hasInvitation : null,
            conversationReplied ? strings.mail.replied : null,
            conversationForwarded ? strings.mail.forwarded : null,
            conversationMuted ? strings.mail.muted : null,
            conversationLate ? strings.mail.arrivedLater : null,
            strings.mail.threadMessages(group.items.length),
            group.unread > 0 ? strings.mail.threadUnread(group.unread) : null,
            headerFolder ? strings.mail.inFolder(headerFolder) : null,
            formatFullMessageDate(
              group.newest.receivedAt,
              listNow,
              dateFormatters,
            ),
            formatBytes(group.newest.size),
          ]
            .filter(Boolean)
            .join(", ")}
          onFocus={() => setFocusedOptionKey(optionKey)}
          onKeyDown={(event) => handleOptionKeyDown(event, optionKey)}
        >
          <span
            className="unread-dot"
            aria-hidden="true"
            data-unread={group.unread > 0}
          />
          <span
            className="message-sender"
            title={senderAddressTitle(group.newest)}
          >
            <HighlightedText
              text={conversationPeople(group)}
              terms={marks.correspondent}
            />
          </span>
          <MessageWhen
            message={group.newest}
            now={listNow}
            formatters={dateFormatters}
          />
          <span className="message-subject">
            {conversationStarred ? (
              <Star
                className="message-mark star-mark"
                fill="currentColor"
                aria-hidden="true"
              />
            ) : null}
            {headerFolder ? (
              <span className="message-folder">{headerFolder}</span>
            ) : null}
            {conversationPinned ? (
              <Pin className="message-mark pin-mark" aria-hidden="true" />
            ) : null}
            {conversationMuted ? (
              <span className="message-muted">{strings.mail.muted}</span>
            ) : null}
            <span>
              <HighlightedText
                text={group.newest.subject || strings.common.noSubject}
                terms={marks.subject}
              />
            </span>
            {conversationFiles ? (
              <span className="message-file-count">
                {strings.mail.draftFiles(conversationFiles)}
              </span>
            ) : conversationAttachment ? (
              <Paperclip aria-hidden="true" />
            ) : null}
            <ImportanceMark importance={conversationImportance} />
            {conversationCalendar ? (
              <CalendarDays className="message-mark" aria-hidden="true" />
            ) : null}
            {conversationReplied ? (
              <Reply className="message-mark" aria-hidden="true" />
            ) : null}
            {conversationForwarded ? (
              <Forward className="message-mark" aria-hidden="true" />
            ) : null}
            <strong className="thread-count">{group.items.length}</strong>
            {group.unread > 0 ? (
              <span className="thread-unread">
                {strings.mail.threadUnread(group.unread)}
              </span>
            ) : null}
          </span>
          {showMessagePreviews ? (
            <span className="message-preview">
              {group.newest.preview || strings.mail.openToDownload}
            </span>
          ) : null}
        </button>
        {rowActions(group.newest, true, conversationStarred, group.unread > 0)}
      </div>
    );
  }

  function renderOption(option: VisibleOption, groupEnd: boolean) {
    if (option.kind === "header") {
      const group = option.groupKey
        ? threadsById.get(option.groupKey)
        : undefined;
      return group ? renderThreadHeader(group, groupEnd) : null;
    }
    return renderRow(
      option.message,
      option.key,
      option.groupKey,
      option.groupKey !== undefined ? 2 : undefined,
      groupEnd,
    );
  }

  function renderDay(item: Extract<VirtualItem, { kind: "day" }>) {
    const dayCountLabel =
      item.count > 0 ? (
        <span className="list-day-count">
          {strings.mail.threadMessages(item.count)}
        </span>
      ) : null;
    return (
      <div
        role="presentation"
        aria-hidden="true"
        className={`list-day-group${item.first ? " first" : ""}`}
      >
        {onSelectDay ? (
          <button
            type="button"
            className="list-day"
            aria-label={`${strings.mail.selectDay(item.label)}, ${strings.mail.threadMessages(item.count)}`}
            title={strings.mail.selectDay(item.label)}
            // Pointer shortcut only; the rows keep the day in their names.
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => pickDay(item.ids)}
          >
            <span>{item.label}</span>
            {dayCountLabel}
          </button>
        ) : (
          <div className="list-day">
            <span>{item.label}</span>
            {dayCountLabel}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="message-list"
      ref={listRef}
      onPointerDown={() => {
        pointerPick.current = true;
      }}
      onKeyDown={() => {
        pointerPick.current = false;
      }}
      onScroll={() => {
        const top = listRef.current?.scrollTop ?? 0;
        if (scrollKey) rememberListScroll(scrollKey, top);
        if (top < 48) setNewAtTop(false);
      }}
    >
      {newAtTop ? (
        <button
          type="button"
          className="new-messages"
          onClick={() => {
            if (listRef.current) listRef.current.scrollTop = 0;
            setNewAtTop(false);
          }}
        >
          {strings.mail.newMessages}
        </button>
      ) : null}
      <div
        role={hasThreadedGroups ? "tree" : "listbox"}
        aria-label={strings.mail.messages}
        aria-busy={loading}
        aria-multiselectable={
          !hasThreadedGroups && selecting ? true : undefined
        }
        className="message-list-items"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {renderedRows.map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="virtual-row"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {item.kind === "day"
                ? renderDay(item)
                : renderOption(item.option, item.groupEnd)}
            </div>
          );
        })}
      </div>
      {hasMore ? (
        <button
          type="button"
          className="load-more-button"
          onClick={() => void onLoadMore()}
          disabled={loading}
        >
          {loading
            ? strings.mail.loadingOlder
            : (loadMoreLabel ?? strings.mail.loadOlder)}
        </button>
      ) : null}
    </div>
  );
}
