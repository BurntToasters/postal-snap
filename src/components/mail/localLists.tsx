import { outboxDetail } from "../../outboxDetail";
import { useEffect, useState } from "react";
import { Clock, FileText, Send, TriangleAlert, X } from "lucide-react";
import {
  formatFullMessageDate,
  formatMessageDate,
  formatScheduledTime,
} from "../../format";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { MessageSummary } from "../../types";

export function SnoozedList({
  items,
  emptyLabel,
  onOpen,
  onUnsnooze,
}: {
  items: ReturnType<typeof useAppStore.getState>["snoozed"];
  emptyLabel?: string;
  onOpen: (message: MessageSummary) => Promise<void>;
  onUnsnooze: (id: number) => Promise<void>;
}) {
  if (items.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {emptyLabel ?? strings.mail.noSnoozed}
      </div>
    );
  return (
    <div className="local-mail-list">
      {items.map((item) => (
        <div key={item.message.id} className="message-row-wrap">
          <button
            type="button"
            className="local-mail-row snoozed-row"
            data-context="snoozed"
            data-message-id={item.message.id}
            onClick={() => void onOpen(item.message)}
            aria-label={[
              item.message.isRead ? strings.mail.read : strings.mail.unread,
              item.message.senderName || item.message.senderAddress,
              item.message.subject || strings.common.noSubject,
              strings.mail.snoozedUntil(formatMessageDate(item.snoozedUntil)),
            ].join(", ")}
          >
            <Clock aria-hidden="true" />
            <span>
              <strong>
                {item.message.subject || strings.common.noSubject}
              </strong>
              <small>
                {item.message.senderName || item.message.senderAddress}
              </small>
              <small>
                {strings.mail.snoozedUntil(
                  formatMessageDate(item.snoozedUntil),
                )}
              </small>
            </span>
            <time
              dateTime={item.message.receivedAt}
              title={formatFullMessageDate(item.message.receivedAt)}
            >
              {formatMessageDate(item.message.receivedAt)}
            </time>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void onUnsnooze(item.message.id)}
            aria-label={`${strings.mail.unsnooze}: ${item.message.subject || strings.common.noSubject}`}
            title={strings.mail.unsnooze}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function DraftList({
  drafts,
  accountEmail,
  emptyLabel,
  onOpen,
}: {
  drafts: ReturnType<typeof useAppStore.getState>["drafts"];
  accountEmail: string;
  emptyLabel?: string;
  onOpen: (id: string) => Promise<void>;
}) {
  if (drafts.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {emptyLabel ?? strings.mail.noDrafts}
      </div>
    );
  return (
    <div className="local-mail-list">
      {drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          className="local-mail-row"
          data-context="draft"
          data-draft-id={draft.id}
          onClick={() => void onOpen(draft.id)}
          aria-label={
            draft.syncDetail
              ? `${draft.subject || strings.common.noSubject} — ${draft.syncDetail}`
              : undefined
          }
        >
          <FileText aria-hidden="true" />
          <span>
            <strong>{draft.subject || strings.common.noSubject}</strong>
            <small>{draft.recipients || strings.mail.noRecipientYet}</small>
            {draftKindLabel(draft.sourceKind) ? (
              <small className="draft-kind">
                {draftKindLabel(draft.sourceKind)}
              </small>
            ) : null}
            {draft.preview ? (
              <small className="draft-preview">{draft.preview}</small>
            ) : null}
            {draft.attachmentCount ? (
              <small className="draft-files">
                {strings.mail.draftFiles(draft.attachmentCount)}
              </small>
            ) : null}
            {draftFromLabel(draft.fromAddress, accountEmail) ? (
              <small className="draft-from">
                {draftFromLabel(draft.fromAddress, accountEmail)}
              </small>
            ) : null}
            <small
              className={`draft-sync-state ${draft.syncState}`}
              title={draft.syncDetail ?? undefined}
            >
              {draft.syncState === "synced"
                ? strings.mail.savedServer
                : draft.syncState === "conflict"
                  ? strings.mail.recoveredConflict
                  : draft.syncState === "localOnly"
                    ? strings.mail.savedLocal
                    : strings.mail.savingServer}
            </small>
          </span>
          <time
            dateTime={draft.updatedAt}
            title={formatFullMessageDate(draft.updatedAt)}
          >
            {formatMessageDate(draft.updatedAt)}
          </time>
        </button>
      ))}
    </div>
  );
}

function draftKindLabel(
  kind: ReturnType<typeof useAppStore.getState>["drafts"][number]["sourceKind"],
): string | undefined {
  if (kind === "reply" || kind === "reply_all") return strings.mail.draftReply;
  if (kind === "forward") return strings.mail.draftForward;
  if (kind === "redirect") return strings.mail.draftRedirect;
  return undefined;
}

function draftFromLabel(
  fromAddress: string | undefined,
  accountEmail: string,
): string | undefined {
  const from = fromAddress?.trim() ?? "";
  if (!from || from.toLowerCase() === accountEmail.trim().toLowerCase()) {
    return undefined;
  }
  return strings.mail.draftFrom(from);
}

// Seconds only near the end; a far send time reads as a clock time.
function scheduledLabel(sendAt: string, now: number): string {
  const seconds = Math.max(
    0,
    Math.round((new Date(sendAt).getTime() - now) / 1000),
  );
  if (seconds < 120) return strings.mail.sendIn(seconds);
  if (seconds < 60 * 60)
    return strings.mail.sendInMinutes(Math.round(seconds / 60));
  return strings.mail.sendsAt(formatScheduledTime(sendAt, new Date(now)));
}

export function OutboxList({
  items,
  emptyLabel,
  sendingIds,
  onOpen,
  onRetry,
  onRetryAll,
  onRetryCopy,
  onRetryArchive,
  onSendNow,
  onEdit,
  onDiscard,
}: {
  items: ReturnType<typeof useAppStore.getState>["outbox"];
  emptyLabel?: string;
  sendingIds?: ReadonlySet<string>;
  onOpen?: (id: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onRetryAll?: () => Promise<void>;
  onRetryCopy: (id: string) => Promise<void>;
  onRetryArchive?: (id: string) => Promise<void>;
  onSendNow: (id: string) => Promise<void>;
  onEdit?: (
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) => Promise<void>;
  onDiscard: (
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) => Promise<void>;
}) {
  const hasScheduled = items.some((item) => item.state === "scheduled");
  const attention = items.filter((item) => item.state === "needs_attention");
  const retryingAll = attention.some((item) =>
    sendingIds?.has(`${item.accountId}:${item.id}`),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasScheduled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasScheduled]);
  if (items.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {emptyLabel ?? strings.mail.noQueued}
      </div>
    );
  return (
    <div className="local-mail-list">
      {onRetryAll && attention.length >= 2 ? (
        <div className="outbox-retry-all">
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void onRetryAll()}
            disabled={retryingAll}
          >
            {strings.mail.retryAll}
          </button>
        </div>
      ) : null}
      {items.map((item) => {
        const sending =
          sendingIds?.has(`${item.accountId}:${item.id}`) ?? false;
        return (
          <article
            key={item.id}
            className="attention-row"
            data-state={item.state}
            data-context="outbox"
            data-outbox-id={item.id}
            data-busy={sending ? "true" : undefined}
          >
            {item.state === "needs_attention" ||
            item.state === "archive_pending" ? (
              <TriangleAlert aria-hidden="true" />
            ) : (
              <Send aria-hidden="true" />
            )}
            <span>
              <strong>{item.subject || strings.common.noSubject}</strong>
              <small>{item.recipients || strings.mail.noRecipient}</small>
              {item.preview ? (
                <small className="outbox-preview">{item.preview}</small>
              ) : null}
              {item.attachmentCount ? (
                <small className="outbox-files">
                  {strings.mail.draftFiles(item.attachmentCount)}
                </small>
              ) : null}
              {item.createdAt ? (
                <time
                  className="outbox-queued"
                  dateTime={item.createdAt}
                  title={formatFullMessageDate(item.createdAt)}
                >
                  {strings.mail.queuedAt(formatMessageDate(item.createdAt))}
                </time>
              ) : null}
              <small>{outboxDetail(item)}</small>
              {item.state === "scheduled" && item.sendAt ? (
                <small className="status-label">
                  {scheduledLabel(item.sendAt, now)}
                </small>
              ) : null}
              <small className="status-label">
                {item.state === "queued"
                  ? strings.mail.waitingSend
                  : item.state === "sending"
                    ? strings.mail.sending
                    : item.state === "sent_copy_pending"
                      ? strings.mail.sentCopyPending
                      : item.state === "archive_pending"
                        ? strings.mail.archivePending
                        : item.state === "scheduled"
                          ? strings.mail.scheduledWaiting
                          : strings.mail.needsAttention}
              </small>
            </span>
            <div>
              {onOpen ? (
                <button type="button" onClick={() => void onOpen(item.id)}>
                  {strings.contextMenu.open}
                </button>
              ) : null}
              {onEdit &&
              (item.state === "queued" || item.state === "needs_attention") ? (
                <button
                  type="button"
                  onClick={() => void onEdit(item.id, item.state)}
                  disabled={sending}
                >
                  {strings.mail.editQueued}
                </button>
              ) : null}
              {item.state === "needs_attention" ? (
                <button type="button" onClick={() => void onRetry(item.id)}>
                  {strings.mail.retrySending}
                </button>
              ) : item.state === "sent_copy_pending" ? (
                <button type="button" onClick={() => void onRetryCopy(item.id)}>
                  {strings.mail.saveSentCopy}
                </button>
              ) : item.state === "archive_pending" && onRetryArchive ? (
                <button
                  type="button"
                  onClick={() => void onRetryArchive(item.id)}
                  disabled={sending}
                >
                  {strings.mail.retryArchive}
                </button>
              ) : item.state === "scheduled" ? (
                <button
                  type="button"
                  onClick={() => void onSendNow(item.id)}
                  disabled={sending}
                  aria-label={
                    sending
                      ? strings.mail.sendingNow(
                          item.subject || strings.common.noSubject,
                        )
                      : undefined
                  }
                >
                  {sending ? strings.mail.sending : strings.mail.sendNow}
                </button>
              ) : null}
              <button
                type="button"
                className="danger-button"
                onClick={() => void onDiscard(item.id, item.state)}
                disabled={sending}
              >
                {item.state === "sent_copy_pending" ||
                item.state === "archive_pending"
                  ? strings.mail.dismissWarning
                  : item.state === "scheduled"
                    ? strings.mail.undoSend
                    : strings.common.discard}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
