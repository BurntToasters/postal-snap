import { useCallback } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { ComposeDraft, MessageSummary } from "../../types";
import { useScheduledOutbox } from "../../hooks/useScheduledOutbox";
import { waitToMarkRead } from "../../markRead";
import { beginMessageOpen, isCurrentMessageOpen } from "../../messageOpen";
import { messageAfterRemoval, messageAfterRemovals } from "../../threads";
import { isOversizeError } from "./mailSearch";

type AppState = ReturnType<typeof useAppStore.getState>;

interface Options {
  activeAccountId: AppState["activeAccountId"];
  loadAccountData: () => Promise<void>;
  refreshList: () => Promise<void>;
  chooseMessage: (summary: MessageSummary) => Promise<boolean>;
  setLoadingMessageId: (id: number | undefined) => void;
  setOutboxPreview: (draft: ComposeDraft | null) => void;
  scheduledSendInFlight: ReturnType<
    typeof useScheduledOutbox
  >["scheduledSendInFlight"];
  selectMessage: AppState["selectMessage"];
  openComposer: AppState["openComposer"];
  setDrafts: AppState["setDrafts"];
  setError: AppState["setError"];
}

export function useLocalListActions({
  activeAccountId,
  loadAccountData,
  refreshList,
  chooseMessage,
  setLoadingMessageId,
  setOutboxPreview,
  scheduledSendInFlight,
  selectMessage,
  openComposer,
  setDrafts,
  setError,
}: Options) {
  async function duplicateDraft(id: string) {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    try {
      const draft = await api.getDraft(id, accountId);
      const saved = await api.saveDraft({
        ...draft,
        id: undefined,
        sendAt: null,
      });
      const drafts = await api.listDrafts(accountId);
      const current = useAppStore.getState();
      if (
        current.activeAccountId !== accountId ||
        current.activeLocalView !== "drafts"
      )
        return;
      setDrafts(drafts);
      openComposer({
        draft: { ...draft, id: saved.id, sendAt: null },
        draftSummary: drafts.find((item) => item.id === saved.id),
      });
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function discardListedDraft(id: string) {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    const confirmed = await api.showNativeConfirm(
      strings.composer.discard,
      strings.composer.discardQuestion,
    );
    if (!confirmed) return;
    try {
      await api.deleteDraft(id, accountId);
      const latest = useAppStore.getState();
      if (latest.composeSeed?.draft?.id === id) latest.closeComposer();
      if (latest.activeAccountId !== accountId) return;
      const drafts = await api.listDrafts(accountId);
      if (useAppStore.getState().activeAccountId !== accountId) return;
      setDrafts(drafts);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function continueDraft(id: string) {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    try {
      const draft = await api.getDraft(id, accountId);
      const current = useAppStore.getState();
      if (current.activeAccountId !== accountId) return;
      openComposer({
        draft,
        draftSummary: current.drafts.find((item) => item.id === id),
      });
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function openDraft(id: string) {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    try {
      const draft = await api.getDraft(id, accountId);
      const current = useAppStore.getState();
      if (
        current.activeAccountId !== accountId ||
        current.activeLocalView !== "drafts"
      )
        return;
      openComposer({
        draft,
        draftSummary: current.drafts.find((draft) => draft.id === id),
      });
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function retryAllQueued() {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    const pending = useAppStore
      .getState()
      .outbox.filter(
        (item) =>
          item.accountId === accountId && item.state === "needs_attention",
      );
    if (pending.length < 2) return;
    const confirmed = await api.showNativeConfirm(
      strings.mail.retryAll,
      strings.mail.retryAllWarning(pending.length),
    );
    if (!confirmed) return;
    let failed = 0;
    for (const item of pending) {
      try {
        await api.retryOutbox(item.id, accountId);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) setError(strings.mail.retryAllFailed(failed));
    await loadAccountData();
  }

  async function retryQueued(id: string) {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.mail.retrySending,
      strings.mail.retryWarning,
    );
    if (!confirmed) return;
    try {
      await api.retryOutbox(id, activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
      await loadAccountData();
    }
  }

  async function retrySentCopy(id: string) {
    if (!activeAccountId) return;
    try {
      await api.retrySentCopy(id, activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
      await loadAccountData();
    }
  }

  async function retryArchiveAfterSend(id: string) {
    if (!activeAccountId) return;
    try {
      await api.retryArchiveAfterSend(id, activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
      await loadAccountData();
    }
  }

  async function unsnoozeById(id: number) {
    if (!activeAccountId) return;
    try {
      await api.unsnoozeMessage(activeAccountId, id);
      await loadAccountData();
      await refreshList();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleSnoozedMessage(accountId: string, messageId: number) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== accountId) return;
    const request = beginMessageOpen();
    const next = current.activeLocalView
      ? undefined
      : messageAfterRemoval(
          current.messages,
          current.settings.groupThreads &&
            (current.mailboxSort ?? "date") === "date",
          messageId,
        );
    if (
      current.selectedMessage?.id === messageId &&
      current.selectedMessage.accountId === accountId
    ) {
      selectMessage(undefined);
    }
    await loadAccountData();
    await refreshList();
    if (!isCurrentMessageOpen(request)) return;
    const after = useAppStore.getState();
    if (after.activeAccountId !== accountId || after.activeLocalView) return;
    const summary = next
      ? after.messages.find((item) => item.id === next.id)
      : undefined;
    if (summary) await chooseMessage(summary);
  }

  async function handleConversationSnoozed(
    accountId: string,
    messageIds: number[],
  ) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== accountId) return;
    const request = beginMessageOpen();
    const removed = new Set(messageIds);
    const anchor =
      current.selectedMessage && removed.has(current.selectedMessage.id)
        ? current.selectedMessage
        : current.messages.find((item) => removed.has(item.id));
    const next =
      current.activeLocalView || !anchor
        ? undefined
        : messageAfterRemovals(
            current.messages,
            current.settings.groupThreads &&
              (current.mailboxSort ?? "date") === "date",
            removed,
            anchor.id,
          );
    if (
      current.selectedMessage &&
      removed.has(current.selectedMessage.id) &&
      current.selectedMessage.accountId === accountId
    ) {
      selectMessage(undefined);
    }
    await loadAccountData();
    await refreshList();
    if (!isCurrentMessageOpen(request)) return;
    const after = useAppStore.getState();
    if (after.activeAccountId !== accountId || after.activeLocalView) return;
    const summary = next
      ? after.messages.find((item) => item.id === next.id)
      : undefined;
    if (summary) await chooseMessage(summary);
  }

  const chooseSnoozed = useCallback(
    async (summary: MessageSummary) => {
      const accountId = activeAccountId;
      if (!accountId) return;
      const request = beginMessageOpen();
      setLoadingMessageId(summary.id);
      try {
        const detail = await api.getMessage(accountId, summary.id);
        const current = useAppStore.getState();
        if (
          !isCurrentMessageOpen(request) ||
          current.activeAccountId !== accountId ||
          current.activeLocalView !== "snoozed"
        )
          return;
        selectMessage(detail);
        const readyToMark = !summary.isRead
          ? await waitToMarkRead(
              useAppStore.getState().settings.markRead,
              () => {
                const latest = useAppStore.getState();
                return (
                  isCurrentMessageOpen(request) &&
                  latest.activeAccountId === accountId &&
                  latest.activeLocalView === "snoozed" &&
                  latest.selectedMessage?.id === summary.id
                );
              },
            )
          : false;
        if (readyToMark) {
          await api.setMessageFlags(accountId, summary.id, true, undefined);
          await loadAccountData();
        }
      } catch (cause) {
        if (!isCurrentMessageOpen(request)) return;
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
    },
    [
      activeAccountId,
      loadAccountData,
      selectMessage,
      setError,
      setLoadingMessageId,
    ],
  );

  async function previewQueued(id: string) {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    try {
      const draft = await api.getOutbox(id, accountId);
      if (useAppStore.getState().activeAccountId !== accountId) return;
      setOutboxPreview(draft);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function editQueued(
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) {
    if (!activeAccountId) return;
    if (state !== "queued" && state !== "needs_attention") return;
    if (scheduledSendInFlight?.has(`${activeAccountId}:${id}`)) return;
    if (state === "needs_attention") {
      const confirmed = await api.showNativeConfirm(
        strings.mail.editUncertainTitle,
        strings.mail.editUncertainDetail,
      );
      if (!confirmed) return;
    }
    try {
      const draft = await api.restoreOutbox(id, activeAccountId);
      openComposer({ draft });
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function discardQueued(
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) {
    if (!activeAccountId) return;
    const question =
      state === "archive_pending"
        ? strings.mail.dismissArchiveWarning
        : state === "sent_copy_pending"
          ? strings.mail.dismissSentCopy
          : state === "scheduled"
            ? strings.mail.undoSendQuestion
            : strings.mail.discardQueued;
    const title =
      state === "archive_pending"
        ? strings.mail.dismissWarning
        : strings.composer.discard;
    const confirmed = await api.showNativeConfirm(title, question);
    if (!confirmed) return;
    try {
      if (state === "scheduled") {
        const draft = await api.restoreOutbox(id, activeAccountId);
        openComposer({ draft });
      } else if (state === "archive_pending") {
        await api.dismissArchiveWarning(id, activeAccountId);
      } else {
        await api.deleteOutbox(id, activeAccountId);
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  return {
    duplicateDraft,
    discardListedDraft,
    continueDraft,
    openDraft,
    retryAllQueued,
    retryQueued,
    retrySentCopy,
    retryArchiveAfterSend,
    unsnoozeById,
    handleSnoozedMessage,
    handleConversationSnoozed,
    chooseSnoozed,
    previewQueued,
    editQueued,
    discardQueued,
  };
}
