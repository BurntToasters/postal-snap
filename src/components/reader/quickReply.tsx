import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { strings } from "../../i18n";
import { useAppStore, type ComposerSeed } from "../../store";
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
  replyNotes,
}: {
  message: MessageDetail;
  replyNotes: ReplyNotes;
}) {
  const openComposer = useAppStore((state) => state.openComposer);
  const settings = useAppStore((state) => state.settings);
  const accounts = useAppStore((state) => state.accounts);
  const fieldId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const note = replyNotes.notes[message.id] ?? "";
  const text = note.trim();
  const account = accounts.find((item) => item.id === message.accountId);
  const accountEmail = account?.email ?? "";
  const aliases = account?.aliases ?? [];
  const people = quickReplyAudience(
    message,
    settings.replyToAll,
    accountEmail,
    aliases,
  );

  // Grow with the text; CSS min and max heights bound the result.
  function fit() {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    const style = getComputedStyle(node);
    const borders =
      parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    node.style.height = `${node.scrollHeight + borders}px`;
  }
  useLayoutEffect(fit, [note, message.id]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  function start(seed: ComposerSeed) {
    openComposer(seed);
    replyNotes.clearWhenOpened(message.id, seed, text);
  }

  return (
    <form
      className="quick-reply"
      data-filled={note ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!text) return;
        start({
          sourceMessage: message,
          composeMode: preferredReplyMode(
            message,
            settings.replyToAll,
            accountEmail,
            aliases,
          ),
          quoteExcerpt: messageSelectionQuote(),
          replyNote: text,
        });
      }}
    >
      <label className="visually-hidden" htmlFor={fieldId}>
        {strings.reader.quickReply}
      </label>
      <textarea
        id={fieldId}
        ref={field}
        value={note}
        placeholder={strings.reader.quickReply}
        rows={1}
        onChange={(event) =>
          replyNotes.remember(message.id, event.target.value)
        }
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
            return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="quick-reply-footer">
        {people ? (
          <p className="quick-reply-to">
            {strings.reader.quickReplyTo(people)}
          </p>
        ) : null}
        <div className="quick-reply-actions">
          {replyAllAddsRecipients(message, accountEmail, aliases) ? (
            <button
              type="button"
              className="toolbar-button"
              aria-label={strings.reader.startReplyAll}
              disabled={!text}
              onClick={() => {
                if (!text) return;
                start({
                  sourceMessage: message,
                  composeMode: "replyAll",
                  quoteExcerpt: messageSelectionQuote(),
                  replyNote: text,
                });
              }}
            >
              {strings.reader.replyAll}
            </button>
          ) : null}
          <button
            type="submit"
            className="primary-button"
            aria-label={strings.reader.startReply}
            disabled={!text}
          >
            {strings.reader.reply}
          </button>
        </div>
      </div>
    </form>
  );
}
