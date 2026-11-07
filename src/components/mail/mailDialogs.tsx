import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import {
  folderMoveDestinations,
  type FolderMoveDestination,
} from "../../folderMove";
import { folderPathLabel } from "../../i18n/mail";
import { strings } from "../../i18n";
import { DEFAULT_NOTICE_TIMEOUT_MS, type NoticeAction } from "../../notices";
import { useAppStore, type SentNotice } from "../../store";
import type { ComposeDraft, MailboxSummary } from "../../types";
import { SetupWizard } from "../SetupWizard";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

const SENT_NOTICE_ID = "sent-notice";

/** Mirrors `lastSent` into the notice queue; the sent notice shares the stack with Undo. */
export function SentNoticeToast() {
  const lastSent = useAppStore((state) => state.lastSent);

  useEffect(() => {
    if (!lastSent) return;
    const notice = lastSent;
    const holdMs =
      !notice.scheduled && notice.undoSeconds !== undefined
        ? notice.undoSeconds * 1000
        : undefined;
    const undo = holdMs === undefined ? [] : [undoAction(notice)];
    useAppStore.getState().pushNotice({
      id: SENT_NOTICE_ID,
      severity: "success",
      className: "sent-toast",
      message: notice.scheduled
        ? strings.mail.messageScheduled
        : strings.composer.messageHeld,
      timeoutMs: holdMs ?? DEFAULT_NOTICE_TIMEOUT_MS,
      // The Undo window is the longest this notice may stay visible.
      maxVisibleMs: holdMs,
      actions: [
        ...undo,
        {
          id: "view-outbox",
          label: strings.mail.viewOutbox,
          run: () => {
            const store = useAppStore.getState();
            store.selectAccount(notice.accountId);
            store.selectLocalView("outbox");
          },
        },
      ],
      onEnd: () => {
        const store = useAppStore.getState();
        if (store.lastSent === notice) store.setLastSent(undefined);
      },
    });
  }, [lastSent]);

  return null;
}

function undoAction(notice: SentNotice): NoticeAction {
  return {
    id: "undo-send",
    label: strings.mail.undoSend,
    run: async () => {
      const store = useAppStore.getState();
      try {
        // Restoring also cancels a queued Send and archive in Rust.
        const draft = await api.restoreOutbox(
          notice.outboxId,
          notice.accountId,
        );
        store.setLastSent(undefined);
        store.openComposer({ draft });
      } catch (cause) {
        store.setError(String(cause));
      }
    },
  };
}

export function MoveFolderDialog({
  mailbox,
  mailboxes,
  busy,
  onMove,
  onClose,
}: {
  mailbox: MailboxSummary;
  mailboxes: MailboxSummary[];
  busy: boolean;
  onMove: (parentId: number | null) => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  useInertBackground();
  const titleId = useId();
  const destinations: FolderMoveDestination[] = folderMoveDestinations(
    mailbox,
    mailboxes,
  );
  return createPortal(
    <div
      className="modal-layer settings-confirm-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <h2 id={titleId}>{strings.mail.moveFolder}</h2>
        <p>{strings.mail.moveFolderDetail(folderPathLabel(mailbox))}</p>
        <div className="move-folder-choices">
          {destinations.map((destination) => (
            <button
              key={destination.parentId ?? "top"}
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => onMove(destination.parentId)}
            >
              {destination.label}
            </button>
          ))}
        </div>
        <div className="settings-confirm-actions">
          <button type="button" className="toolbar-button" onClick={onClose}>
            {strings.common.cancel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function outboxPlainText(draft: ComposeDraft): string {
  const text = draft.textBody.split("\u0000").join("").trim();
  if (text) return text;
  return draft.htmlBody
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function OutboxPreviewDialog({
  draft,
  onClose,
}: {
  draft: ComposeDraft;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  useInertBackground();
  const title = draft.subject.trim() || strings.common.noSubject;
  const body = outboxPlainText(draft);
  const lines = [
    draft.to.length > 0 ? `${strings.reader.to} ${draft.to.join(", ")}` : "",
    draft.cc.length > 0 ? `${strings.reader.cc} ${draft.cc.join(", ")}` : "",
    draft.bcc.length > 0 ? `${strings.reader.bcc} ${draft.bcc.join(", ")}` : "",
  ].filter((line) => line.length > 0);
  return createPortal(
    <div className="modal-layer attachment-preview-layer">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={strings.common.close}
        onClick={onClose}
      />
      <section
        className="attachment-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
      >
        <header>
          <div>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={strings.common.close}
            title={strings.common.close}
          >
            {strings.common.close}
          </button>
        </header>
        <div className="original-body">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <pre>{body || strings.mail.outboxEmptyBody}</pre>
          {draft.attachments.length > 0 ? (
            <ul>
              {draft.attachments.map((item) => (
                <li key={item.token}>{item.filename}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function AddAccountDialog({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const dialogRef = useDialogFocus(onClose);
  useInertBackground();
  return createPortal(
    <div className="modal-layer setup-modal">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={strings.mail.closeAddAccount}
        onClick={onClose}
      />
      <section
        className="setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={strings.mail.addEmailAccount}
        ref={dialogRef}
      >
        <button
          type="button"
          className="secondary-button setup-dialog-close"
          onClick={onClose}
        >
          {strings.common.close}
        </button>
        <SetupWizard embedded onComplete={onComplete} />
      </section>
    </div>,
    document.body,
  );
}
