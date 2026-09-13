import { useEffect, useId, useRef, useState } from "react";
import { Paperclip, Star } from "lucide-react";
import { formatMessageDate } from "../../format";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { groupThreads } from "../../threads";
import type { MessageSummary } from "../../types";

type VisibleOption = {
  key: string;
  kind: "header" | "message";
  message: MessageSummary;
  groupKey?: string;
};

export function MessageList({
  messages,
  selectedId,
  loading,
  loadingMessageId,
  onChoose,
  hasMore,
  onLoadMore,
  searchQuery,
  onClearSearch,
  selecting,
  selectedIds,
  onToggleSelect,
}: {
  messages: MessageSummary[];
  selectedId?: number;
  loading: boolean;
  loadingMessageId?: number;
  onChoose: (message: MessageSummary) => Promise<void>;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  searchQuery?: string;
  onClearSearch?: () => void;
  selecting?: boolean;
  selectedIds?: number[];
  onToggleSelect?: (id: number) => void;
}) {
  const groupConversations = useAppStore(
    (state) => state.settings.groupThreads,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [expandedThreads, setExpandedThreads] = useState<string[]>([]);
  const [focusedOptionKey, setFocusedOptionKey] = useState<string>();

  function toggleThread(key: string) {
    setExpandedThreads((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  }

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      "[role='option'][aria-selected='true'], [role='treeitem'][aria-selected='true']",
    );
    if (!selected) return;
    selected.scrollIntoView?.({ block: "nearest" });
    if (listRef.current?.contains(document.activeElement)) selected.focus();
  }, [selectedId]);

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

  const visibleOptions: VisibleOption[] =
    groupedThreads.length > 0
      ? groupedThreads.flatMap((group) => {
          if (group.items.length === 1) {
            return [
              {
                key: `message:${group.newest.id}`,
                kind: "message" as const,
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
        })
      : messages.map((message) => ({
          key: `message:${message.id}`,
          kind: "message" as const,
          message,
        }));

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
      );
    }
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.emptyMailbox}
      </div>
    );
  }
  function focusOption(option: VisibleOption) {
    const optionElement = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(
        "[role='option'], [role='treeitem']",
      ) ?? [],
    ).find((element) => element.dataset.optionKey === option.key);
    optionElement?.focus();
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
    if (!selecting) void onChoose(next.message);
  }

  function renderRow(
    message: MessageSummary,
    optionKey: string,
    groupKey?: string,
    treeLevel?: number,
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
    const rowLabel = [
      message.isRead ? strings.mail.read : strings.mail.unread,
      message.isStarred ? strings.mail.starred : null,
      message.senderName || message.senderAddress,
      message.subject || strings.common.noSubject,
      formatMessageDate(message.receivedAt),
      message.hasAttachments ? strings.mail.hasAttachments : null,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <div key={message.id} className="message-row-wrap">
        {selecting ? (
          <input
            type="checkbox"
            className="message-select"
            checked={checked}
            onChange={() => onToggleSelect?.(message.id)}
            aria-label={strings.mail.selectMessage(
              message.subject || strings.common.noSubject,
            )}
          />
        ) : null}
        <button
          type="button"
          role={rowRole}
          aria-selected={isSelected}
          aria-level={rowRole === "treeitem" ? (treeLevel ?? 1) : undefined}
          data-option-key={optionKey}
          tabIndex={activeOptionKey === optionKey ? 0 : -1}
          aria-label={rowLabel}
          className={`message-row ${message.isRead ? "read" : "unread"} ${!selecting && isSelected ? "selected" : ""} ${checked ? "checked" : ""}`}
          onClick={() =>
            selecting ? onToggleSelect?.(message.id) : void onChoose(message)
          }
          onFocus={() => setFocusedOptionKey(optionKey)}
          onKeyDown={(event) => handleOptionKeyDown(event, optionKey)}
        >
          <span className="unread-dot" aria-hidden="true" />
          <span className="message-sender">
            {message.senderName || message.senderAddress}
          </span>
          <time className="message-date" dateTime={message.receivedAt}>
            {formatMessageDate(message.receivedAt)}
          </time>
          <span className="message-subject">
            {message.isStarred ? (
              <Star fill="currentColor" aria-hidden="true" />
            ) : null}
            <span>{message.subject || strings.common.noSubject}</span>
            {message.hasAttachments ? <Paperclip aria-hidden="true" /> : null}
          </span>
          <span className="message-preview">
            {loadingMessageId === message.id
              ? strings.mail.downloadingMessage
              : message.preview || strings.mail.openToDownload}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="message-list">
      <div
        ref={listRef}
        role={hasThreadedGroups ? "tree" : "listbox"}
        aria-label={strings.mail.messages}
        aria-busy={loading}
        aria-multiselectable={
          !hasThreadedGroups && selecting ? true : undefined
        }
      >
        {selecting || !groupConversations
          ? messages.map((message) =>
              renderRow(message, `message:${message.id}`),
            )
          : groupedThreads.map((group, index) => {
              if (group.items.length === 1) {
                return renderRow(group.newest, `message:${group.newest.id}`);
              }
              const expanded = effectiveExpanded.includes(group.key);
              const childrenId = `thread-children-${listId}-${index}`;
              return (
                <div key={group.key} className="thread-group">
                  <button
                    type="button"
                    role="treeitem"
                    aria-selected={selectedId === group.newest.id}
                    aria-level={1}
                    data-option-key={`thread:${group.key}`}
                    tabIndex={
                      activeOptionKey === `thread:${group.key}` ? 0 : -1
                    }
                    className={`message-row thread-header ${group.newest.id === selectedId ? "selected" : ""} ${group.unread > 0 ? "unread" : "read"}`}
                    aria-expanded={expanded}
                    aria-owns={expanded ? childrenId : undefined}
                    onClick={() => {
                      void onChoose(group.newest);
                      toggleThread(group.key);
                    }}
                    aria-label={[
                      strings.mail.conversation,
                      group.newest.subject || strings.common.noSubject,
                      strings.mail.threadMessages(group.items.length),
                      group.unread > 0
                        ? strings.mail.threadUnread(group.unread)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    onFocus={() => setFocusedOptionKey(`thread:${group.key}`)}
                    onKeyDown={(event) =>
                      handleOptionKeyDown(event, `thread:${group.key}`)
                    }
                  >
                    <span
                      className="unread-dot"
                      aria-hidden="true"
                      data-unread={group.unread > 0}
                    />
                    <span className="message-sender">
                      {group.newest.senderName || group.newest.senderAddress}
                    </span>
                    <time
                      className="message-date"
                      dateTime={group.newest.receivedAt}
                    >
                      {formatMessageDate(group.newest.receivedAt)}
                    </time>
                    <span className="message-subject">
                      <span>
                        {group.newest.subject || strings.common.noSubject}
                      </span>
                      <strong className="thread-count">
                        {group.items.length}
                      </strong>
                    </span>
                    <span className="message-preview">
                      {group.newest.preview || strings.mail.openToDownload}
                    </span>
                  </button>
                  {expanded ? (
                    <div
                      role="group"
                      id={childrenId}
                      className="thread-children"
                    >
                      {group.items.map((message) =>
                        renderRow(
                          message,
                          `message:${message.id}`,
                          group.key,
                          2,
                        ),
                      )}
                    </div>
                  ) : null}
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
          {loading ? strings.mail.loadingOlder : strings.mail.loadOlder}
        </button>
      ) : null}
    </div>
  );
}
