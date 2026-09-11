import { useEffect, useRef, useState } from "react";
import { Paperclip, Star } from "lucide-react";
import { formatMessageDate } from "../../format";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { groupThreads } from "../../threads";
import type { MessageSummary } from "../../types";

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
  const [expandedThreads, setExpandedThreads] = useState<string[]>([]);

  function toggleThread(key: string) {
    setExpandedThreads((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  }

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      "[role='option'][aria-selected='true']",
    );
    if (!selected) return;
    selected.scrollIntoView?.({ block: "nearest" });
    if (listRef.current?.contains(document.activeElement)) selected.focus();
  }, [selectedId]);

  // The open message's thread stays expanded without storing it:
  // deriving keeps render pure and survives list reloads.
  const selectedThreadKey = selectedId
    ? groupThreads(messages).find(
        (group) =>
          group.items.length > 1 &&
          group.items.some((item) => item.id === selectedId),
      )?.key
    : undefined;
  const effectiveExpanded =
    selectedThreadKey && !expandedThreads.includes(selectedThreadKey)
      ? [...expandedThreads, selectedThreadKey]
      : expandedThreads;

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
  function renderRow(message: MessageSummary, index: number) {
    const checked = selecting && (selectedIds ?? []).includes(message.id);
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
          role="option"
          aria-selected={selecting ? checked : selectedId === message.id}
          tabIndex={
            selecting
              ? 0
              : selectedId === message.id || (!selectedId && index === 0)
                ? 0
                : -1
          }
          aria-label={rowLabel}
          className={`message-row ${message.isRead ? "read" : "unread"} ${!selecting && selectedId === message.id ? "selected" : ""} ${checked ? "checked" : ""}`}
          onClick={() =>
            selecting ? onToggleSelect?.(message.id) : void onChoose(message)
          }
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            event.stopPropagation();
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? messages.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        messages.length - 1,
                        index + (event.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
            const next = messages[nextIndex];
            if (!next || next.id === message.id) return;
            if (selecting) {
              const list = event.currentTarget.closest("[role='listbox']");
              list
                ?.querySelectorAll<HTMLElement>("[role='option']")
                ?.[nextIndex]?.focus();
              return;
            }
            void onChoose(next);
          }}
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
        role="listbox"
        aria-label={strings.mail.messages}
        aria-busy={loading}
      >
        {selecting || !groupConversations
          ? messages.map((message, index) => renderRow(message, index))
          : groupThreads(messages).map((group) => {
              if (group.items.length === 1) {
                return renderRow(group.newest, messages.indexOf(group.newest));
              }
              const expanded = effectiveExpanded.includes(group.key);
              return (
                <div key={group.key} className="thread-group" role="group">
                  <button
                    type="button"
                    className={`message-row thread-header ${group.newest.id === selectedId ? "selected" : ""} ${group.unread > 0 ? "unread" : "read"}`}
                    aria-expanded={expanded}
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
                  {expanded
                    ? group.items.map((message) =>
                        renderRow(message, messages.indexOf(message)),
                      )
                    : null}
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
