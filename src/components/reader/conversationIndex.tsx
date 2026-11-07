import { useLayoutEffect, useRef, useState } from "react";
import { formatFullMessageDate, formatMessageDate } from "../../format";
import { strings } from "../../i18n";
import type { MessageDetail, MessageSummary } from "../../types";

export function ConversationIndex({
  conversation,
  message,
  indexSender,
  onOpenInConversation,
}: {
  conversation: MessageSummary[];
  message: MessageDetail;
  indexSender: (item: { senderName: string; senderAddress: string }) => string;
  onOpenInConversation?: (message: MessageSummary) => void;
}) {
  // Only an overflowing index is a keyboard stop (scroll region).
  const navRef = useRef<HTMLElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const node = navRef.current;
    if (!node) return;
    const check = () =>
      setScrollable(node.scrollHeight > node.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [conversation]);
  return conversation.length > 1 ? (
    <nav
      ref={navRef}
      className="conversation-index"
      aria-label={strings.reader.conversationMessages}
      tabIndex={scrollable ? 0 : undefined}
    >
      {conversation.map((item) => {
        const subject = item.subject || strings.common.noSubject;
        // The name lists the row's text in visible order, so axe finds the label inside it.
        const name = [
          subject,
          item.isRead ? null : strings.mail.unread,
          indexSender(item),
          formatMessageDate(item.receivedAt),
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === message.id ? "true" : undefined}
            aria-label={name}
            onClick={() => {
              if (item.id !== message.id) onOpenInConversation?.(item);
            }}
          >
            {item.subject === message.subject ? null : (
              <>
                <span>{subject}</span>{" "}
              </>
            )}
            {!item.isRead ? (
              <>
                <span className="conversation-index-unread">
                  {strings.mail.unread}
                </span>{" "}
              </>
            ) : null}
            <span className="conversation-index-sender">
              {indexSender(item)}
            </span>{" "}
            <time
              dateTime={item.receivedAt}
              title={formatFullMessageDate(item.receivedAt)}
            >
              {formatMessageDate(item.receivedAt)}
            </time>
          </button>
        );
      })}
    </nav>
  ) : null;
}
