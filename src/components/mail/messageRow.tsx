import { memo, type DragEvent, type KeyboardEvent } from "react";
import {
  ArrowDown,
  CalendarDays,
  CircleAlert,
  Flag,
  Forward,
  Paperclip,
  Pin,
  Reply,
} from "lucide-react";
import {
  formatBytes,
  formatFullMessageDate,
  formatMessageListWhen,
  notableArrival,
  type ListDateFormatters,
} from "../../format";
import { strings } from "../../i18n";
import { flagColorName } from "../../flagColors";
import { recordRender } from "../../devPerf";
import { HighlightedText } from "../HighlightedText";
import { RowActions } from "./rowActions";
import { highlightTerms } from "../../searchHighlight";
import type { MessageSummary } from "../../types";

export function MessageWhen({
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
        <>
          {" "}
          <span className="message-arrived">{strings.mail.arrivedLater}</span>
        </>
      ) : null}
    </span>
  );
}

export function ImportanceMark({ importance }: { importance?: string }) {
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

export interface MessageRowProps {
  message: MessageSummary;
  /** Primitive snapshot of the fields a row shows; see rowStateKey. */
  stateKey: string;
  optionKey: string;
  groupKey?: string;
  treeLevel?: number;
  groupEnd: boolean;
  rowRole: "treeitem" | "option";
  position?: number;
  setSize: number;
  selecting: boolean;
  checked: boolean;
  isSelected: boolean;
  /** The next row is selected; hides this row's separator. */
  precedesSelection?: boolean;
  /** The roving tab stop: the one row Tab lands on. */
  tabStop: boolean;
  correspondent: string;
  senderTitle?: string;
  folder?: string;
  showSizes: boolean;
  showPreviews: boolean;
  /** This row's body is downloading. */
  loading: boolean;
  fromArchive: boolean;
  inTrash: boolean;
  canStar: boolean;
  canRead: boolean;
  searchQuery: string;
  /** Minute-stable clock; labels only change when it does. */
  now: Date;
  formatters: ListDateFormatters;
  onChoose: (message: MessageSummary) => Promise<void>;
  onSelectRow: (id: number, shift: boolean) => void;
  onCheckRow: (id: number) => void;
  onFocusRow: (key: string) => void;
  onKeyDownRow: (event: KeyboardEvent<HTMLElement>, key: string) => void;
  onDragStartRow: (
    event: DragEvent<HTMLButtonElement>,
    message: MessageSummary,
    key: string,
  ) => void;
  onDragEndRow: () => void;
  onStarRow?: (message: MessageSummary) => void;
  onReadRow?: (message: MessageSummary) => void;
  onArchiveRow?: (message: MessageSummary, conversation: boolean) => void;
  onTrashRow?: (message: MessageSummary, conversation: boolean) => void;
}

export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const {
    message,
    optionKey,
    groupKey,
    treeLevel,
    groupEnd,
    rowRole,
    position,
    setSize,
    selecting,
    checked,
    isSelected,
    precedesSelection = false,
    tabStop,
    correspondent,
    senderTitle,
    folder,
    showSizes,
    showPreviews,
    loading,
    fromArchive,
    inTrash,
    canStar,
    canRead,
    searchQuery,
    now,
    formatters,
    onChoose,
    onSelectRow,
    onCheckRow,
    onFocusRow,
    onKeyDownRow,
    onDragStartRow,
    onDragEndRow,
    onStarRow,
    onReadRow,
    onArchiveRow,
    onTrashRow,
  } = props;
  recordRender("messageRow", optionKey);
  const marks = highlightTerms(searchQuery);
  // The visible text stays one in-order run so the name contains it (WCAG 2.5.3).
  const rowLabel = [
    message.isRead ? strings.mail.read : strings.mail.unread,
    message.isStarred
      ? strings.mail.flaggedAs(flagColorName(message.flagColor))
      : null,
    message.pinned ? strings.mail.pinned : null,
    correspondent,
    formatMessageListWhen(message.receivedAt, now, formatters),
    // Visible text must stay one run in order (WCAG 2.5.3); hidden size goes last.
    showSizes ? formatBytes(message.size) : null,
    notableArrival(message.receivedAt, message.arrivedAt)
      ? strings.mail.arrivedLater
      : null,
    message.conversationMuted ? strings.mail.muted : null,
    message.subject || strings.common.noSubject,
    message.attachmentCount
      ? strings.mail.draftFiles(message.attachmentCount)
      : null,
    showPreviews || loading
      ? loading
        ? strings.mail.downloadingMessage
        : message.preview || strings.mail.openToDownload
      : null,
    showSizes ? null : formatBytes(message.size),
    senderTitle,
    folder ? strings.mail.inFolder(folder) : null,
    formatFullMessageDate(message.receivedAt, now, formatters),
    !message.attachmentCount && message.hasAttachments
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
              onSelectRow(message.id, shift);
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
        aria-posinset={position}
        aria-setsize={setSize}
        data-option-key={optionKey}
        data-context="message"
        data-message-id={message.id}
        tabIndex={tabStop ? 0 : -1}
        aria-label={rowLabel}
        className={`message-row ${message.isRead ? "read" : "unread"} ${!selecting && isSelected ? "selected" : ""} ${checked ? "checked" : ""} ${precedesSelection ? "precedes-selection" : ""}`}
        draggable
        onDragStart={(event) => onDragStartRow(event, message, optionKey)}
        onDragEnd={onDragEndRow}
        onClick={(event) => {
          if (!selecting) {
            // Cmd+click on macOS (Ctrl there opens the menu), Ctrl+click elsewhere, starts select mode.
            const checkModifier =
              document.documentElement.dataset.platform === "macos"
                ? event.metaKey
                : event.ctrlKey;
            if (checkModifier) onCheckRow(message.id);
            else void onChoose(message);
            return;
          }
          onSelectRow(message.id, event.shiftKey);
        }}
        onFocus={() => onFocusRow(optionKey)}
        onKeyDown={(event) => onKeyDownRow(event, optionKey)}
      >
        <span className="unread-dot" aria-hidden="true" />
        <span className="message-sender" title={senderTitle}>
          <HighlightedText text={correspondent} terms={marks.correspondent} />
        </span>{" "}
        <MessageWhen message={message} now={now} formatters={formatters} />{" "}
        <span className="message-subject">
          {message.isStarred ? (
            <Flag
              className="message-mark star-mark"
              data-flag-color={message.flagColor ?? 0}
              fill="currentColor"
              aria-hidden="true"
            />
          ) : null}
          {folder ? (
            <>
              <span className="message-folder">{folder}</span>{" "}
            </>
          ) : null}
          {message.pinned ? (
            <Pin className="message-mark pin-mark" aria-hidden="true" />
          ) : null}
          {message.conversationMuted ? (
            <>
              <span className="message-muted">{strings.mail.muted}</span>{" "}
            </>
          ) : null}
          <span>
            <HighlightedText
              text={message.subject || strings.common.noSubject}
              terms={marks.subject}
            />
          </span>
          {message.attachmentCount ? (
            <>
              {" "}
              <span className="message-file-count">
                {strings.mail.draftFiles(message.attachmentCount)}
              </span>
            </>
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
        </span>{" "}
        {showPreviews || loading ? (
          <span className="message-preview">
            {loading ? (
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
      {selecting ? null : (
        <RowActions
          message={message}
          conversation={false}
          starred={message.isStarred}
          flagColor={message.flagColor}
          unread={!message.isRead}
          fromArchive={fromArchive}
          inTrash={inTrash}
          onStar={canStar && onStarRow ? () => onStarRow(message) : undefined}
          onRead={canRead && onReadRow ? () => onReadRow(message) : undefined}
          onArchive={onArchiveRow}
          onTrash={onTrashRow}
        />
      )}
    </div>
  );
});
