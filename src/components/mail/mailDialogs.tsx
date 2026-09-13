import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { SetupWizard } from "../SetupWizard";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

export function SentNoticeToast() {
  const lastSent = useAppStore((state) => state.lastSent);
  const setLastSent = useAppStore((state) => state.setLastSent);
  const openComposer = useAppStore((state) => state.openComposer);
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
        <SetupWizard onComplete={onComplete} />
      </section>
    </div>,
    document.body,
  );
}
