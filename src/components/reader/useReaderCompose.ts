import type { RefObject } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { messageSelectionQuote } from "../composer/composerSeed";

interface Options {
  openComposer: ReturnType<typeof useAppStore.getState>["openComposer"];
  setError: (error?: string) => void;
  setMoreOpen: (open: boolean) => void;
  preparingForward: boolean;
  setPreparingForward: (preparing: boolean) => void;
  forwardOperation: RefObject<number>;
}

export function useReaderCompose({
  openComposer,
  setError,
  setMoreOpen,
  preparingForward,
  setPreparingForward,
  forwardOperation,
}: Options) {
  async function editAsNewMessage() {
    const message = useAppStore.getState().selectedMessage;
    if (!message || preparingForward) return;
    const operation = ++forwardOperation.current;
    const messageId = message.id;
    const accountId = message.accountId;
    setPreparingForward(true);
    try {
      const attachments = await api.prepareForwardAttachments(
        accountId,
        messageId,
      );
      const current = useAppStore.getState();
      if (
        operation !== forwardOperation.current ||
        current.activeAccountId !== accountId ||
        current.selectedMessage?.id !== messageId
      )
        return;
      openComposer({
        sourceMessage: message,
        composeMode: "editAsNew",
        prefill: { attachments },
      });
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation === forwardOperation.current &&
        current.activeAccountId === accountId &&
        current.selectedMessage?.id === messageId
      )
        setError(String(cause));
    } finally {
      if (operation === forwardOperation.current) setPreparingForward(false);
    }
  }

  function redirectMessage() {
    const message = useAppStore.getState().selectedMessage;
    if (!message) return;
    setMoreOpen(false);
    openComposer({
      composeMode: "redirect",
      sourceMessage: message,
    });
  }

  async function forwardAsAttachment() {
    const message = useAppStore.getState().selectedMessage;
    if (!message || preparingForward) return;
    const operation = ++forwardOperation.current;
    const messageId = message.id;
    const accountId = message.accountId;
    setPreparingForward(true);
    try {
      const attachment = await api.prepareForwardedMessage(
        accountId,
        messageId,
      );
      const current = useAppStore.getState();
      if (
        operation !== forwardOperation.current ||
        current.activeAccountId !== accountId ||
        current.selectedMessage?.id !== messageId
      )
        return;
      openComposer({
        sourceMessage: message,
        composeMode: "forwardAttachment",
        prefill: { attachments: [attachment] },
      });
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation === forwardOperation.current &&
        current.activeAccountId === accountId &&
        current.selectedMessage?.id === messageId
      )
        setError(String(cause));
    } finally {
      if (operation === forwardOperation.current) setPreparingForward(false);
    }
  }

  async function replyWithAttachments(composeMode: "reply" | "replyAll") {
    const message = useAppStore.getState().selectedMessage;
    if (!message || preparingForward) return;
    if (!message.attachments.some((item) => !item.inline)) {
      setError(strings.reader.noFilesToAttach);
      return;
    }
    const operation = ++forwardOperation.current;
    const messageId = message.id;
    const accountId = message.accountId;
    setPreparingForward(true);
    try {
      const attachments = await api.prepareReplyAttachments(
        accountId,
        messageId,
      );
      const files = attachments.filter((item) => !item.inline);
      const current = useAppStore.getState();
      if (
        operation !== forwardOperation.current ||
        current.activeAccountId !== accountId ||
        current.selectedMessage?.id !== messageId
      )
        return;
      if (files.length === 0) {
        setError(strings.reader.noFilesToAttach);
        return;
      }
      openComposer({
        sourceMessage: message,
        composeMode,
        quoteExcerpt: messageSelectionQuote(),
        prefill: { attachments: files },
      });
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation === forwardOperation.current &&
        current.activeAccountId === accountId &&
        current.selectedMessage?.id === messageId
      )
        setError(String(cause));
    } finally {
      if (operation === forwardOperation.current) setPreparingForward(false);
    }
  }

  async function forwardMessage() {
    const message = useAppStore.getState().selectedMessage;
    if (!message || preparingForward) return;
    const operation = ++forwardOperation.current;
    const messageId = message.id;
    const accountId = message.accountId;
    setPreparingForward(true);
    try {
      const attachments = await api.prepareForwardAttachments(
        accountId,
        messageId,
      );
      const current = useAppStore.getState();
      if (
        operation !== forwardOperation.current ||
        current.activeAccountId !== accountId ||
        current.selectedMessage?.id !== messageId
      )
        return;
      openComposer({
        sourceMessage: message,
        composeMode: "forward",
        prefill: { attachments },
      });
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation === forwardOperation.current &&
        current.activeAccountId === accountId &&
        current.selectedMessage?.id === messageId
      )
        setError(String(cause));
    } finally {
      if (operation === forwardOperation.current) setPreparingForward(false);
    }
  }

  return {
    editAsNewMessage,
    redirectMessage,
    forwardAsAttachment,
    replyWithAttachments,
    forwardMessage,
  };
}
