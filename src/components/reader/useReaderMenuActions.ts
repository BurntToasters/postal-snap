/* eslint-disable react-hooks/exhaustive-deps -- mount-only listeners; code moved verbatim. */
import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { api } from "../../api";
import {
  CONTEXT_ACTION_EVENT,
  addressMailbox,
  senderRuleNeedle,
  subjectRuleNeedle,
  type ContextMenuActionDetail,
} from "../../contextMenu";
import { forwardLoadedConversation } from "../../forwardConversation";
import { useAppStore } from "../../store";
import {
  listPostAddress,
  messageSelectionQuote,
  preferredReplyMode,
} from "../composer/composerSeed";
import { readableMessageText } from "./readerUtils";

interface Options {
  openComposer: ReturnType<typeof useAppStore.getState>["openComposer"];
  replyWithAttachments: (composeMode: "reply" | "replyAll") => Promise<void>;
  forwardMessage: () => Promise<void>;
  forwardAsAttachment: () => Promise<void>;
  redirectMessage: () => void;
  editAsNewMessage: () => Promise<void>;
  move: (role: "archive" | "trash" | "junk") => Promise<void>;
  blockSender: () => Promise<void>;
  unblockSender: () => Promise<void>;
  blockDomain: () => Promise<void>;
  unblockDomain: () => Promise<void>;
  muteConversation: () => Promise<void>;
  deleteForever: () => Promise<void>;
  moveToInbox: () => void;
  moveToMailbox: (mailboxId: number) => Promise<void>;
  copyToMailbox: (mailboxId: number) => Promise<void>;
  setRead: () => Promise<void>;
  setStarred: () => Promise<void>;
  previewFile: (attachmentId: string) => Promise<void>;
  download: (attachmentId: string, filename: string) => Promise<void>;
  copyRecipients: () => Promise<void>;
  printMessageRef: RefObject<() => void>;
  findInputRef: RefObject<HTMLInputElement | null>;
  setFindOpen: Dispatch<SetStateAction<boolean>>;
  scrollMessage: (direction: 1 | -1) => void;
  setSnoozeConversation: Dispatch<SetStateAction<boolean>>;
  setSnoozeOpen: Dispatch<SetStateAction<boolean>>;
  keepSnooze: RefObject<boolean>;
  frame: RefObject<HTMLIFrameElement | null>;
}

export function useReaderMenuActions({
  openComposer,
  replyWithAttachments,
  forwardMessage,
  forwardAsAttachment,
  redirectMessage,
  editAsNewMessage,
  move,
  blockSender,
  unblockSender,
  blockDomain,
  unblockDomain,
  muteConversation,
  deleteForever,
  moveToInbox,
  moveToMailbox,
  copyToMailbox,
  setRead,
  setStarred,
  previewFile,
  download,
  copyRecipients,
  printMessageRef,
  findInputRef,
  setFindOpen,
  scrollMessage,
  setSnoozeConversation,
  setSnoozeOpen,
  keepSnooze,
  frame,
}: Options) {
  const menuHandlersRef = useRef({
    openComposer,
    replyWithAttachments,
    forwardMessage,
    forwardAsAttachment,
    redirectMessage,
    editAsNewMessage,
    move,
    blockSender,
    unblockSender,
    blockDomain,
    unblockDomain,
    muteConversation,
    deleteForever,
    moveToInbox,
    moveToMailbox,
    copyToMailbox,
    setRead,
    setStarred,
    previewFile,
    download,
    copyRecipients,
  });

  useEffect(() => {
    menuHandlersRef.current = {
      openComposer,
      replyWithAttachments,
      forwardMessage,
      forwardAsAttachment,
      redirectMessage,
      editAsNewMessage,
      move,
      blockSender,
      unblockSender,
      blockDomain,
      unblockDomain,
      muteConversation,
      deleteForever,
      moveToInbox,
      moveToMailbox,
      copyToMailbox,
      setRead,
      setStarred,
      previewFile,
      download,
      copyRecipients,
    };
  });

  useEffect(() => {
    const menuAction = (event: Event) => {
      const h = menuHandlersRef.current;
      const selected = useAppStore.getState().selectedMessage;
      if (!selected) return;
      const action = (event as CustomEvent<string>).detail;
      if (action === "reply")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "reply",
          quoteExcerpt: messageSelectionQuote(),
        });
      if (action === "reply-preferred") {
        const account = useAppStore
          .getState()
          .accounts.find((item) => item.id === selected.accountId);
        h.openComposer({
          sourceMessage: selected,
          composeMode: preferredReplyMode(
            selected,
            useAppStore.getState().settings.replyToAll,
            account?.email ?? "",
            account?.aliases ?? [],
          ),
          quoteExcerpt: messageSelectionQuote(),
        });
      }
      if (action === "reply-all")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "replyAll",
          quoteExcerpt: messageSelectionQuote(),
        });
      if (action === "reply-bare")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "reply",
          omitQuote: true,
        });
      if (action === "reply-all-bare")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "replyAll",
          omitQuote: true,
        });
      if (action === "reply-list" && listPostAddress(selected.listPost))
        h.openComposer({
          sourceMessage: selected,
          composeMode: "replyList",
          quoteExcerpt: messageSelectionQuote(),
        });
      if (action === "reply-with-attachments")
        void h.replyWithAttachments("reply");
      if (action === "reply-all-with-attachments")
        void h.replyWithAttachments("replyAll");
      if (action === "forward") void h.forwardMessage();
      if (action === "forward-conversation")
        void forwardLoadedConversation(selected);
      if (action === "forward-attachment") void h.forwardAsAttachment();
      if (action === "redirect") h.redirectMessage();
      if (action === "edit-as-new") void h.editAsNewMessage();
      if (action === "archive") void h.move("archive");
      if (action === "move-to-inbox") void h.moveToInbox();
      if (action === "trash") void h.move("trash");
      if (action === "delete-forever") void h.deleteForever();
      if (action === "toggle-read") void h.setRead();
      if (action === "toggle-star") void h.setStarred();
      if (action === "junk") void h.move("junk");
      if (action === "block-sender") void h.blockSender();
      if (action === "unblock-sender") void h.unblockSender();
      if (action === "block-domain") void h.blockDomain();
      if (action === "unblock-domain") void h.unblockDomain();
      if (action === "mute-conversation") void h.muteConversation();
      if (action === "not-junk") {
        const inbox = useAppStore
          .getState()
          .mailboxes.find((box) => box.role === "inbox");
        if (inbox) void h.moveToMailbox(inbox.id);
      }
      if (action === "copy-recipients") void h.copyRecipients();
      if (action === "save-eml") {
        void api
          .saveMessageEml(selected.accountId, selected.id)
          .catch((cause) => {
            useAppStore.getState().setError(String(cause));
          });
      }
      if (action === "print" || action === "file-print") {
        window.dispatchEvent(new Event("postal:print-message"));
      }
      if (action === "find-in-message") {
        window.dispatchEvent(new Event("postal:find-in-message"));
      }
      if (action === "create-rule") {
        const contains = senderRuleNeedle(selected.senderAddress);
        if (!contains) return;
        window.dispatchEvent(
          new CustomEvent("postal:create-rule", {
            detail: { accountId: selected.accountId, contains, field: "from" },
          }),
        );
      }
      if (action === "create-subject-rule") {
        const contains = subjectRuleNeedle(selected.subject);
        if (!contains) return;
        window.dispatchEvent(
          new CustomEvent("postal:create-rule", {
            detail: {
              accountId: selected.accountId,
              contains,
              field: "subject",
            },
          }),
        );
      }
    };
    window.addEventListener("postal:menu-action", menuAction);
    return () => window.removeEventListener("postal:menu-action", menuAction);
  }, []);

  useEffect(() => {
    const print = () => printMessageRef.current();
    const find = () => {
      setFindOpen(true);
      window.setTimeout(() => findInputRef.current?.focus(), 0);
    };
    const scroll = (event: Event) => {
      const direction = (event as CustomEvent<1 | -1>).detail;
      scrollMessage(direction);
    };
    window.addEventListener("postal:print-message", print);
    window.addEventListener("postal:find-in-message", find);
    window.addEventListener("postal:scroll-reader", scroll);
    const openSnooze = () => {
      setSnoozeConversation(false);
      setSnoozeOpen(true);
    };
    const openConversationSnooze = () => {
      keepSnooze.current = true;
      setSnoozeConversation(true);
      setSnoozeOpen(true);
    };
    const moveMailbox = (event: Event) => {
      const mailboxId = (event as CustomEvent<number>).detail;
      if (typeof mailboxId === "number") {
        void menuHandlersRef.current.moveToMailbox(mailboxId);
      }
    };
    const copyMailbox = (event: Event) => {
      const mailboxId = (event as CustomEvent<number>).detail;
      if (typeof mailboxId === "number") {
        void menuHandlersRef.current.copyToMailbox(mailboxId);
      }
    };
    const contextAction = (event: Event) => {
      const detail = (event as CustomEvent<ContextMenuActionDetail>).detail;
      if (!detail) return;
      if (detail.id === "find-in-message" && detail.target.kind === "reader") {
        find();
        return;
      }
      if (detail.id === "print" && detail.target.kind === "reader") {
        print();
        return;
      }
      if (detail.id === "copy" && detail.target.kind === "reader") {
        const iframeText =
          frame.current?.contentDocument?.getSelection()?.toString() ?? "";
        const parentText = window.getSelection()?.toString() ?? "";
        const text = iframeText || parentText;
        if (text)
          void navigator.clipboard.writeText(text).catch(() => undefined);
        return;
      }
      if (detail.id === "copy-subject" && detail.target.kind === "reader") {
        const subject =
          useAppStore.getState().selectedMessage?.subject.trim() ?? "";
        if (subject)
          void navigator.clipboard.writeText(subject).catch(() => undefined);
        return;
      }
      if (
        detail.id === "copy-sender-address" &&
        detail.target.kind === "reader"
      ) {
        const address = addressMailbox(
          useAppStore.getState().selectedMessage?.senderAddress ?? "",
        );
        if (address)
          void navigator.clipboard.writeText(address).catch(() => undefined);
        return;
      }
      if (
        detail.id === "copy-message-text" &&
        detail.target.kind === "reader"
      ) {
        const selected = useAppStore.getState().selectedMessage;
        const text = selected ? readableMessageText(selected) : "";
        if (text)
          void navigator.clipboard.writeText(text).catch(() => undefined);
        return;
      }
      if (detail.target.kind !== "attachment") return;
      if (detail.id === "preview") {
        void menuHandlersRef.current.previewFile(detail.target.attachmentId);
      }
      if (detail.id === "download") {
        void menuHandlersRef.current.download(
          detail.target.attachmentId,
          detail.target.filename,
        );
      }
    };
    window.addEventListener("postal:open-snooze", openSnooze);
    window.addEventListener(
      "postal:open-snooze-conversation",
      openConversationSnooze,
    );
    window.addEventListener("postal:move-mailbox", moveMailbox);
    window.addEventListener("postal:copy-mailbox", copyMailbox);
    window.addEventListener(CONTEXT_ACTION_EVENT, contextAction);
    return () => {
      window.removeEventListener("postal:print-message", print);
      window.removeEventListener("postal:find-in-message", find);
      window.removeEventListener("postal:scroll-reader", scroll);
      window.removeEventListener("postal:open-snooze", openSnooze);
      window.removeEventListener(
        "postal:open-snooze-conversation",
        openConversationSnooze,
      );
      window.removeEventListener("postal:move-mailbox", moveMailbox);
      window.removeEventListener("postal:copy-mailbox", copyMailbox);
      window.removeEventListener(CONTEXT_ACTION_EVENT, contextAction);
    };
  }, []);
}
