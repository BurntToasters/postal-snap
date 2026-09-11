import { useEffect, useState } from "react";
import { Clock, FileText, Send, TriangleAlert, X } from "lucide-react";
import { formatMessageDate } from "../../format";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { MessageSummary } from "../../types";

export function SnoozedList({
  items,
  onOpen,
  onUnsnooze,
}: {
  items: ReturnType<typeof useAppStore.getState>["snoozed"];
  onOpen: (message: MessageSummary) => Promise<void>;
  onUnsnooze: (id: number) => Promise<void>;
}) {
  if (items.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.noSnoozed}
      </div>
    );
  return (
    <div className="local-mail-list">
      {items.map((item) => (
        <div key={item.message.id} className="message-row-wrap">
          <button
            type="button"
            className="local-mail-row snoozed-row"
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
            <time dateTime={item.message.receivedAt}>
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
  onOpen,
}: {
  drafts: ReturnType<typeof useAppStore.getState>["drafts"];
  onOpen: (id: string) => Promise<void>;
}) {
  if (drafts.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.noDrafts}
      </div>
    );
  return (
    <div className="local-mail-list">
      {drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          className="local-mail-row"
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
          <time dateTime={draft.updatedAt}>
            {formatMessageDate(draft.updatedAt)}
          </time>
        </button>
      ))}
    </div>
  );
}

export function OutboxList({
  items,
  onRetry,
  onRetryCopy,
  onSendNow,
  onDiscard,
}: {
  items: ReturnType<typeof useAppStore.getState>["outbox"];
  onRetry: (id: string) => Promise<void>;
  onRetryCopy: (id: string) => Promise<void>;
  onSendNow: (id: string) => Promise<void>;
  onDiscard: (
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) => Promise<void>;
}) {
  const hasScheduled = items.some((item) => item.state === "scheduled");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasScheduled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasScheduled]);
  if (items.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.noQueued}
      </div>
    );
  return (
    <div className="local-mail-list">
      {items.map((item) => (
        <article key={item.id} className="attention-row">
          {item.state === "needs_attention" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
          <span>
            <strong>{item.subject || strings.common.noSubject}</strong>
            <small>{item.recipients || strings.mail.noRecipient}</small>
            <small>{item.detail}</small>
            {item.state === "scheduled" && item.sendAt ? (
              <small className="status-label">
                {strings.mail.sendIn(
                  Math.max(
                    0,
                    Math.round((new Date(item.sendAt).getTime() - now) / 1000),
                  ),
                )}
              </small>
            ) : null}
            <small className="status-label">
              {item.state === "queued"
                ? strings.mail.waitingSend
                : item.state === "sending"
                  ? strings.mail.sending
                  : item.state === "sent_copy_pending"
                    ? strings.mail.sentCopyPending
                    : item.state === "scheduled"
                      ? strings.mail.scheduledWaiting
                      : strings.mail.needsAttention}
            </small>
          </span>
          <div>
            {item.state === "needs_attention" ? (
              <button type="button" onClick={() => void onRetry(item.id)}>
                {strings.mail.retrySending}
              </button>
            ) : item.state === "sent_copy_pending" ? (
              <button type="button" onClick={() => void onRetryCopy(item.id)}>
                {strings.mail.saveSentCopy}
              </button>
            ) : item.state === "scheduled" ? (
              <button type="button" onClick={() => void onSendNow(item.id)}>
                {strings.mail.sendNow}
              </button>
            ) : null}
            <button
              type="button"
              className="danger-button"
              onClick={() => void onDiscard(item.id, item.state)}
            >
              {item.state === "sent_copy_pending"
                ? strings.mail.dismissWarning
                : item.state === "scheduled"
                  ? strings.mail.undoSend
                  : strings.common.discard}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
