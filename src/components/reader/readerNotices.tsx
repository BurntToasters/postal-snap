import { ShieldCheck } from "lucide-react";
import { strings } from "../../i18n";
import type { DraftSummary, MessageDetail } from "../../types";

export function JunkTrashBanner({
  isJunkMailbox,
  isTrashMailbox,
  onMoveToInbox,
}: {
  isJunkMailbox: boolean;
  isTrashMailbox: boolean;
  onMoveToInbox: () => void;
}) {
  return isJunkMailbox || isTrashMailbox ? (
    <div className="remote-content-banner warning" role="status">
      <span>
        {isJunkMailbox ? strings.reader.inJunk : strings.reader.inTrash}
      </span>
      <button type="button" onClick={onMoveToInbox}>
        {isJunkMailbox ? strings.reader.notJunk : strings.reader.moveToInbox}
      </button>
    </div>
  ) : null;
}

export function ContinueDraftNotice({
  drafts,
  message,
  onContinueDraft,
}: {
  drafts: DraftSummary[];
  message: MessageDetail;
  onContinueDraft?: (draftId: string) => void;
}) {
  return onContinueDraft
    ? (() => {
        const replyDrafts = drafts.filter(
          (draft) =>
            draft.accountId === message.accountId &&
            draft.sourceMessageId === message.id,
        );
        if (replyDrafts.length === 0) return null;
        const kind = replyDrafts[0]?.sourceKind;
        const note =
          replyDrafts.length > 1
            ? strings.reader.unsentDrafts(replyDrafts.length)
            : kind === "forward"
              ? strings.reader.unsentForward
              : kind === "redirect"
                ? strings.reader.unsentRedirect
                : strings.reader.unsentReply;
        return (
          <div className="continue-draft">
            <p role="status">{note}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onContinueDraft(replyDrafts[0].id)}
            >
              {strings.reader.continueDraft}
            </button>
          </div>
        );
      })()
    : null;
}

export function ReadReceiptBanner({
  receiptView,
  message,
  receiptBusy,
  chooseReceipt,
}: {
  receiptView: string | null;
  message: MessageDetail;
  receiptBusy: boolean;
  chooseReceipt: (send: boolean) => Promise<void>;
}) {
  return (
    <>
      {receiptView === "ask" ? (
        <div className="remote-content-banner">
          <span>
            {strings.reader.readReceiptAsk(
              message.senderName || message.senderAddress,
              message.dispositionTo ?? "",
            )}
          </span>
          <button
            type="button"
            disabled={receiptBusy}
            onClick={() => void chooseReceipt(true)}
          >
            {strings.reader.sendReceipt}
          </button>
          <button
            type="button"
            disabled={receiptBusy}
            onClick={() => void chooseReceipt(false)}
          >
            {strings.reader.declineReceipt}
          </button>
        </div>
      ) : null}
      {receiptView === "sent" ? (
        <div className="remote-content-banner" role="status">
          <span>{strings.reader.receiptSent}</span>
        </div>
      ) : null}
    </>
  );
}

export function UnsubscribeSentNotice({
  unsubscribeSentFor,
  message,
}: {
  unsubscribeSentFor: number | undefined;
  message: MessageDetail;
}) {
  return unsubscribeSentFor === message.id ? (
    <div className="remote-content-banner" role="status" aria-live="polite">
      <ShieldCheck aria-hidden="true" />
      <span>
        <strong>{strings.reader.unsubscribeSent}</strong>{" "}
        {strings.reader.unsubscribeSentDetail}
      </span>
    </div>
  ) : null;
}
