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
  return conversation.length > 1 ? (
    <nav
      className="conversation-index"
      aria-label={strings.reader.conversationMessages}
    >
      {conversation.map((item) => {
        const label = strings.reader.conversationMessage(
          item.subject || strings.common.noSubject,
          indexSender(item),
          formatFullMessageDate(item.receivedAt),
        );
        return (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === message.id ? "true" : undefined}
            aria-label={
              item.isRead ? label : `${strings.mail.unread}, ${label}`
            }
            onClick={() => {
              if (item.id !== message.id) onOpenInConversation?.(item);
            }}
          >
            <span>{item.subject || strings.common.noSubject}</span>
            {!item.isRead ? (
              <span className="conversation-index-unread">
                {strings.mail.unread}
              </span>
            ) : null}
            <span className="conversation-index-sender">
              {indexSender(item)}
            </span>
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
