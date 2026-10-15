import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { MessageDetail } from "../../types";
import {
  messageSelectionQuote,
  preferredReplyMode,
  quickReplyAudience,
  replyAllAddsRecipients,
} from "../composer/composerSeed";
import type { ReplyNotes } from "./useReplyNotes";

export function QuickReply({
  message,
  replyNotes: reply,
}: {
  message: MessageDetail;
  replyNotes: ReplyNotes;
}) {
  const openComposer = useAppStore((state) => state.openComposer);
  const settings = useAppStore((state) => state.settings);
  const accounts = useAppStore((state) => state.accounts);
  const replyNotes = reply.notes;
  const rememberReplyDraft = reply.remember;
  const clearReplyDraft = reply.clear;
  return (
    <form
      className="quick-reply"
      onSubmit={(event) => {
        event.preventDefault();
        const text = (replyNotes[message.id] ?? "").trim();
        if (!text) return;
        const account = accounts.find((item) => item.id === message.accountId);
        openComposer({
          sourceMessage: message,
          composeMode: preferredReplyMode(
            message,
            settings.replyToAll,
            account?.email ?? "",
            account?.aliases ?? [],
          ),
          quoteExcerpt: messageSelectionQuote(),
          replyNote: text,
        });
        clearReplyDraft(message.id);
      }}
    >
      {(() => {
        const account = accounts.find((item) => item.id === message.accountId);
        const people = quickReplyAudience(
          message,
          settings.replyToAll,
          account?.email ?? "",
          account?.aliases ?? [],
        );
        return people ? (
          <p className="quick-reply-to">
            {strings.reader.quickReplyTo(people)}
          </p>
        ) : null;
      })()}
      <label>
        <span className="visually-hidden">{strings.reader.quickReply}</span>
        <textarea
          value={replyNotes[message.id] ?? ""}
          placeholder={strings.reader.quickReply}
          aria-label={strings.reader.quickReply}
          rows={2}
          onChange={(event) =>
            rememberReplyDraft(message.id, event.target.value)
          }
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
              return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
      </label>
      <div className="quick-reply-actions">
        <button
          type="submit"
          className="primary-button"
          aria-label={strings.reader.startReply}
          disabled={!(replyNotes[message.id] ?? "").trim()}
        >
          {strings.reader.reply}
        </button>
        {replyAllAddsRecipients(
          message,
          accounts.find((account) => account.id === message.accountId)?.email ??
            "",
          accounts.find((account) => account.id === message.accountId)
            ?.aliases ?? [],
        ) ? (
          <button
            type="button"
            className="toolbar-button"
            aria-label={strings.reader.startReplyAll}
            disabled={!(replyNotes[message.id] ?? "").trim()}
            onClick={() => {
              const text = (replyNotes[message.id] ?? "").trim();
              if (!text) return;
              openComposer({
                sourceMessage: message,
                composeMode: "replyAll",
                quoteExcerpt: messageSelectionQuote(),
                replyNote: text,
              });
              clearReplyDraft(message.id);
            }}
          >
            {strings.reader.replyAll}
          </button>
        ) : null}
      </div>
    </form>
  );
}
