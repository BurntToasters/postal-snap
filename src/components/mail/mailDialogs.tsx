import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import {
  folderMoveDestinations,
  type FolderMoveDestination,
} from "../../folderMove";
import { folderPathLabel } from "../../i18n/mail";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { ComposeDraft, MailboxSummary } from "../../types";
import { SetupWizard } from "../SetupWizard";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

export function SentNoticeToast() {
  const lastSent = useAppStore((state) => state.lastSent);
  const setLastSent = useAppStore((state) => state.setLastSent);
  const openComposer = useAppStore((state) => state.openComposer);
  const selectAccount = useAppStore((state) => state.selectAccount);
  const selectLocalView = useAppStore((state) => state.selectLocalView);
  const setError = useAppStore((state) => state.setError);
  const [expiredNoticeId, setExpiredNoticeId] = useState<string>();

  useEffect(() => {
    if (!lastSent) return;
    const holdMs =
      !lastSent.scheduled && lastSent.undoSeconds !== undefined
        ? lastSent.undoSeconds * 1000
        : undefined;
    const undoTimer =
      holdMs === undefined
        ? undefined
        : window.setTimeout(
            () => setExpiredNoticeId(lastSent.outboxId),
            holdMs,
          );
    const timer = window.setTimeout(
      () => setLastSent(undefined),
      (holdMs ?? 15_000) + 2_000,
    );
    return () => {
      window.clearTimeout(timer);
      if (undoTimer !== undefined) window.clearTimeout(undoTimer);
    };
  }, [lastSent, setLastSent]);

  if (!lastSent) return null;
  const notice = lastSent;

  async function undoLastSent() {
    try {
      // Restoring also cancels a queued Send and archive in Rust.
      const draft = await api.restoreOutbox(notice.outboxId, notice.accountId);
      setLastSent(undefined);
      openComposer({ draft });
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <div className="toast sent-toast" role="status">
      <span>
        {notice.scheduled
          ? strings.mail.messageScheduled
          : strings.composer.messageHeld}
      </span>
      {notice.outboxId !== expiredNoticeId ? (
        <button type="button" onClick={() => void undoLastSent()}>
          {strings.mail.undoSend}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setLastSent(undefined);
          selectAccount(notice.accountId);
          selectLocalView("outbox");
        }}
      >
        {strings.mail.viewOutbox}
      </button>
      <button
        type="button"
        onClick={() => setLastSent(undefined)}
        aria-label={strings.mail.dismissNotice}
      >
        ×
      </button>
    </div>
  );
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
