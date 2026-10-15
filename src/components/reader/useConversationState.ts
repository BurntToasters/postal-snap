import { sameSenderMessages } from "../../contextMenu";
import { useAppStore } from "../../store";
import {
  conversationIndex,
  conversationMessages,
  conversationRead,
  conversationUnread,
  messageListPosition,
} from "../../threads";
import type { AppSettings, MessageDetail } from "../../types";

export function useConversationState(
  message: MessageDetail | undefined,
  settings: AppSettings,
) {
  const loadedMessages = useAppStore((state) => state.messages);
  const mailboxSort = useAppStore((state) => state.mailboxSort);
  const listPosition = message
    ? messageListPosition(
        loadedMessages,
        settings.groupThreads && (mailboxSort ?? "date") === "date",
        message.id,
      )
    : undefined;
  const conversation = message
    ? conversationIndex(loadedMessages, message)
    : [];
  const listed = useAppStore((state) =>
    message ? state.messages.find((item) => item.id === message.id) : undefined,
  );
  const canMarkConversationRead = useAppStore((state) =>
    message ? conversationUnread(state.messages, message).length > 0 : false,
  );
  const canMarkConversationUnread = useAppStore((state) =>
    message ? conversationRead(state.messages, message).length > 0 : false,
  );
  const canMoveConversation = useAppStore((state) =>
    message ? conversationMessages(state.messages, message).length > 1 : false,
  );
  const canSelectFromSender = useAppStore((state) =>
    message
      ? sameSenderMessages(state.messages, message.senderAddress).length > 1
      : false,
  );
  const canSaveConversationFiles = useAppStore((state) =>
    message
      ? conversationMessages(state.messages, message).some(
          (item) => item.hasAttachments,
        )
      : false,
  );
  const canStarConversation = useAppStore((state) =>
    message
      ? conversationMessages(state.messages, message).some(
          (item) => !item.isStarred,
        )
      : false,
  );
  const canUnstarConversation = useAppStore((state) => {
    if (!message) return false;
    const members = conversationMessages(state.messages, message);
    return members.length > 1 && members.every((item) => item.isStarred);
  });
  const canPinConversation = useAppStore((state) =>
    message
      ? conversationMessages(state.messages, message).some(
          (item) => !item.pinned,
        )
      : false,
  );
  const canUnpinConversation = useAppStore((state) => {
    if (!message) return false;
    const members = conversationMessages(state.messages, message);
    return members.length > 1 && members.every((item) => item.pinned);
  });

  return {
    listPosition,
    conversation,
    listed,
    canMarkConversationRead,
    canMarkConversationUnread,
    canMoveConversation,
    canSelectFromSender,
    canSaveConversationFiles,
    canStarConversation,
    canUnstarConversation,
    canPinConversation,
    canUnpinConversation,
  };
}
