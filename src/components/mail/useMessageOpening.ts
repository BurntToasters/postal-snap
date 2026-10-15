import { useCallback, useEffect, useRef } from "react";
import { api } from "../../api";
import { earlierHeaderId } from "../../contextMenu";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { MessageSummary } from "../../types";
import { waitToMarkRead } from "../../markRead";
import { beginMessageOpen, isCurrentMessageOpen } from "../../messageOpen";
import { rememberedOpenMessage } from "../../recentMessage";
import { isOversizeError } from "./mailSearch";

type AppState = ReturnType<typeof useAppStore.getState>;

interface Options {
  activeAccountId: AppState["activeAccountId"];
  activeMailboxId: AppState["activeMailboxId"];
  activeLocalView: AppState["activeLocalView"];
  messages: AppState["messages"];
  selectedMessage: AppState["selectedMessage"];
  submittedQuery: string;
  loadingMessages: boolean;
  loadAccountData: () => Promise<void>;
  selectMessage: AppState["selectMessage"];
  selectMailbox: AppState["selectMailbox"];
  setError: AppState["setError"];
  setMessages: AppState["setMessages"];
  setLoadingMessageId: (id: number | undefined) => void;
  clearQuery: () => void;
  resetListState: () => void;
}

export function useMessageOpening({
  activeAccountId,
  activeMailboxId,
  activeLocalView,
  messages,
  selectedMessage,
  submittedQuery,
  loadingMessages,
  loadAccountData,
  selectMessage,
  selectMailbox,
  setError,
  setMessages,
  setLoadingMessageId,
  clearQuery,
  resetListState,
}: Options) {
  const chooseMessage = useCallback(
    async (summary: MessageSummary) => {
      const accountId = activeAccountId;
      const mailboxId = activeMailboxId;
      if (!accountId || !mailboxId) return false;
      const request = beginMessageOpen();
      setLoadingMessageId(summary.id);
      try {
        const detail = await api.getMessage(accountId, summary.id);
        const current = useAppStore.getState();
        if (
          !isCurrentMessageOpen(request) ||
          current.activeAccountId !== accountId ||
          current.activeMailboxId !== mailboxId
        )
          return false;
        selectMessage(detail);
        const readyToMark = !summary.isRead
          ? await waitToMarkRead(
              useAppStore.getState().settings.markRead,
              () => {
                const latest = useAppStore.getState();
                return (
                  isCurrentMessageOpen(request) &&
                  latest.activeAccountId === accountId &&
                  latest.activeMailboxId === mailboxId &&
                  !latest.activeLocalView &&
                  latest.selectedMessage?.id === summary.id
                );
              },
            )
          : false;
        if (readyToMark) {
          await api.setMessageFlags(accountId, summary.id, true, undefined);
          const latest = useAppStore.getState();
          if (
            isCurrentMessageOpen(request) &&
            latest.activeAccountId === accountId &&
            latest.activeMailboxId === mailboxId &&
            !latest.activeLocalView
          ) {
            setMessages(
              latest.messages.map((message) =>
                message.id === summary.id
                  ? { ...message, isRead: true }
                  : message,
              ),
              latest.messageCursor,
              latest.hasMoreMessages,
            );
            if (latest.selectedMessage?.id === summary.id)
              selectMessage({ ...detail, isRead: true });
            await loadAccountData();
          }
        }
      } catch (cause) {
        if (!isCurrentMessageOpen(request)) return false;
        const detail = String(cause);
        setError(detail);
        if (isOversizeError(cause)) {
          selectMessage({
            ...summary,
            to: [],
            cc: [],
            replyTo: null,
            textBody: "",
            htmlBody: null,
            remoteImagesBlocked: false,
            attachments: [],
          });
        }
      } finally {
        if (isCurrentMessageOpen(request)) setLoadingMessageId(undefined);
      }
      return useAppStore.getState().selectedMessage?.id === summary.id;
    },
    [
      activeAccountId,
      activeMailboxId,
      loadAccountData,
      selectMessage,
      setError,
      setMessages,
      setLoadingMessageId,
    ],
  );

  const restoreFolder = useRef("");
  const restoredFor = useRef("");
  useEffect(() => {
    const folderKey =
      activeAccountId && activeMailboxId && !activeLocalView
        ? `${activeAccountId}:${activeMailboxId}`
        : "";
    if (restoreFolder.current !== folderKey) {
      restoreFolder.current = folderKey;
      restoredFor.current = "";
    }
    if (
      !folderKey ||
      !activeAccountId ||
      !activeMailboxId ||
      activeLocalView ||
      submittedQuery ||
      loadingMessages ||
      messages.length === 0 ||
      restoredFor.current === folderKey
    ) {
      return;
    }
    restoredFor.current = folderKey;
    if (selectedMessage) return;
    const messageId = rememberedOpenMessage(activeAccountId, activeMailboxId);
    const summary = messages.find((item) => item.id === messageId);
    // An unread message was left unread on purpose; reopening would mark it read.
    if (summary?.isRead) void chooseMessage(summary);
  }, [
    activeAccountId,
    activeLocalView,
    activeMailboxId,
    chooseMessage,
    loadingMessages,
    messages,
    selectedMessage,
    submittedQuery,
  ]);

  async function openEarlierMessage(summary: MessageSummary) {
    const accountId = useAppStore.getState().activeAccountId;
    const detail = useAppStore.getState().selectedMessage;
    if (!accountId || !detail || detail.id !== summary.id) return;
    const headerId = earlierHeaderId(detail);
    if (!headerId) return;
    let found: MessageSummary | null;
    try {
      found = await api.findCachedMessage(accountId, headerId);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    if (!found || found.id === summary.id) {
      setError(strings.reader.earlierMessageMissing);
      return;
    }
    clearQuery();
    resetListState();
    const viewing = useAppStore.getState();
    if (
      found.mailboxId === viewing.activeMailboxId &&
      !viewing.activeLocalView
    ) {
      void chooseMessage(found);
      return;
    }
    selectMailbox(found.mailboxId);
    const mailboxId = found.mailboxId;
    const request = beginMessageOpen();
    setLoadingMessageId(found.id);
    try {
      const opened = await api.getMessage(accountId, found.id);
      const current = useAppStore.getState();
      if (
        !isCurrentMessageOpen(request) ||
        current.activeAccountId !== accountId ||
        current.activeMailboxId !== mailboxId
      )
        return;
      selectMessage(opened);
      const readyToMark = !found.isRead
        ? await waitToMarkRead(useAppStore.getState().settings.markRead, () => {
            const latest = useAppStore.getState();
            return (
              isCurrentMessageOpen(request) &&
              latest.activeAccountId === accountId &&
              latest.activeMailboxId === mailboxId &&
              !latest.activeLocalView &&
              latest.selectedMessage?.id === found.id
            );
          })
        : false;
      if (readyToMark) {
        await api.setMessageFlags(accountId, found.id, true, undefined);
        const latest = useAppStore.getState();
        if (
          isCurrentMessageOpen(request) &&
          latest.activeAccountId === accountId &&
          latest.activeMailboxId === mailboxId &&
          latest.selectedMessage?.id === found.id
        )
          selectMessage({ ...opened, isRead: true });
      }
    } catch (cause) {
      if (isCurrentMessageOpen(request)) setError(String(cause));
    } finally {
      if (isCurrentMessageOpen(request)) setLoadingMessageId(undefined);
    }
  }

  return { chooseMessage, openEarlierMessage };
}
