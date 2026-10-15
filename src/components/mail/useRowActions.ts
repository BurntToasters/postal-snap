import type { Dispatch, SetStateAction } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { MessageSummary } from "../../types";
import { preferredReplyMode } from "../composer/composerSeed";
import {
  deleteListedMessage,
  deleteLoadedConversation,
} from "../../deleteConversation";
import {
  moveListedMessage,
  moveLoadedConversation,
} from "../../moveConversation";
import { beginMessageOpen } from "../../messageOpen";
import { conversationMessages } from "../../threads";

type AppState = ReturnType<typeof useAppStore.getState>;

interface Options {
  setSelectedIds: Dispatch<SetStateAction<number[]>>;
  chooseMessage: (summary: MessageSummary) => Promise<boolean>;
  selectMessage: AppState["selectMessage"];
  setError: AppState["setError"];
  openComposer: AppState["openComposer"];
}

export function useRowActions({
  setSelectedIds,
  chooseMessage,
  selectMessage,
  setError,
  openComposer,
}: Options) {
  function archiveFocused(message: MessageSummary, conversation: boolean) {
    const current = useAppStore.getState();
    const mailbox = current.mailboxes.find(
      (box) => box.id === message.mailboxId,
    );
    const toInbox = mailbox?.role === "archive";
    const loaded = conversation
      ? conversationMessages(current.messages, message)
      : [];
    const members = loaded.length > 1 ? loaded : [message];
    const removed = new Set(members.map((item) => item.id));
    const after = (next?: MessageSummary, openWasMoved?: boolean) => {
      setSelectedIds((ids) => ids.filter((id) => !removed.has(id)));
      if (!openWasMoved) return;
      if (next) void chooseMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    };
    if (members.length > 1) {
      if (toInbox) {
        const inbox = current.mailboxes.find(
          (box) => box.accountId === message.accountId && box.role === "inbox",
        );
        if (!inbox) {
          setError(strings.mail.noInbox);
          return;
        }
        void moveLoadedConversation(message, inbox.id, after);
        return;
      }
      void moveLoadedConversation(message, "archive", after);
      return;
    }
    void moveListedMessage(message, toInbox ? "inbox" : "archive", after);
  }

  function trashFocused(message: MessageSummary, conversation: boolean) {
    const current = useAppStore.getState();
    const mailbox = current.mailboxes.find(
      (box) => box.id === message.mailboxId,
    );
    const loaded = conversation
      ? conversationMessages(current.messages, message)
      : [];
    const members = loaded.length > 1 ? loaded : [message];
    const removed = new Set(members.map((item) => item.id));
    const after = (next?: MessageSummary, openWasMoved?: boolean) => {
      setSelectedIds((ids) => ids.filter((id) => !removed.has(id)));
      if (!openWasMoved) return;
      if (next) void chooseMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    };
    if (mailbox?.role === "trash") {
      if (members.length > 1) {
        void deleteLoadedConversation(message, after);
        return;
      }
      void deleteListedMessage(message, after);
      return;
    }
    if (members.length > 1) {
      void moveLoadedConversation(message, "trash", after);
      return;
    }
    void moveListedMessage(message, "trash", after);
  }

  function junkFocused(message: MessageSummary, conversation: boolean) {
    const current = useAppStore.getState();
    const mailbox = current.mailboxes.find(
      (box) => box.id === message.mailboxId,
    );
    const toInbox = mailbox?.role === "junk";
    const loaded = conversation
      ? conversationMessages(current.messages, message)
      : [];
    const members = loaded.length > 1 ? loaded : [message];
    const removed = new Set(members.map((item) => item.id));
    const after = (next?: MessageSummary, openWasMoved?: boolean) => {
      setSelectedIds((ids) => ids.filter((id) => !removed.has(id)));
      if (!openWasMoved) return;
      if (next) void chooseMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    };
    if (members.length > 1) {
      if (toInbox) {
        const inbox = current.mailboxes.find(
          (box) => box.accountId === message.accountId && box.role === "inbox",
        );
        if (!inbox) {
          setError(strings.mail.noInbox);
          return;
        }
        void moveLoadedConversation(message, inbox.id, after);
        return;
      }
      void moveLoadedConversation(message, "junk", after);
      return;
    }
    void moveListedMessage(message, toInbox ? "inbox" : "junk", after);
  }

  async function replyFocused(
    message: MessageSummary,
    mode: "reply" | "replyAll",
  ) {
    const accountId = message.accountId;
    try {
      const detail = await api.getMessage(accountId, message.id);
      const state = useAppStore.getState();
      if (state.activeAccountId !== accountId) return;
      const account = state.accounts.find((item) => item.id === accountId);
      openComposer({
        sourceMessage: detail,
        composeMode:
          mode === "reply"
            ? preferredReplyMode(
                detail,
                state.settings.replyToAll,
                account?.email ?? "",
                account?.aliases ?? [],
              )
            : mode,
      });
    } catch (cause) {
      setError(String(cause));
    }
  }

  return { archiveFocused, trashFocused, junkFocused, replyFocused };
}
