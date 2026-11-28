import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useRef,
} from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { rangeSelection } from "../../selectionRange";
import { readMessageDrag } from "../../messageDrag";
import { useAppStore } from "../../store";
import type { MessageSummary } from "../../types";
import { pinSelectedMessages } from "../../pinConversation";
import { beginMessageOpen, isCurrentMessageOpen } from "../../messageOpen";
import { messageAfterRemovals } from "../../threads";
import { undoableMove, undoTargetFor } from "../../undoMove";
import { errorText } from "../../errors";

type AppState = ReturnType<typeof useAppStore.getState>;

interface MutationScope {
  accountId: string;
  mailboxId: AppState["activeMailboxId"];
  localView: AppState["activeLocalView"];
  selectedIds: number[];
}

interface Options {
  activeAccountId: AppState["activeAccountId"];
  activeMailboxId: AppState["activeMailboxId"];
  mailboxes: AppState["mailboxes"];
  messages: AppState["messages"];
  listedMessages: MessageSummary[];
  setError: AppState["setError"];
  selectMessage: AppState["selectMessage"];
  refreshList: () => Promise<boolean>;
  loadAccountData: () => Promise<void>;
  chooseMessage: (summary: MessageSummary) => Promise<boolean>;
  selectedIds: number[];
  setSelectedIds: Dispatch<SetStateAction<number[]>>;
  selectionAnchor: MutableRefObject<number | undefined>;
  bulkBusy: boolean;
  setBulkBusy: Dispatch<SetStateAction<boolean>>;
  setSelecting: Dispatch<SetStateAction<boolean>>;
  setSelectionSnoozeOpen: Dispatch<SetStateAction<boolean>>;
}

export function useMessageSelection({
  activeAccountId,
  activeMailboxId,
  mailboxes,
  messages,
  listedMessages,
  setError,
  selectMessage,
  refreshList,
  loadAccountData,
  chooseMessage,
  selectedIds,
  setSelectedIds,
  selectionAnchor,
  bulkBusy,
  setBulkBusy,
  setSelecting,
  setSelectionSnoozeOpen,
}: Options) {
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  function captureMutationScope(accountId: string): MutationScope {
    const current = useAppStore.getState();
    return {
      accountId,
      mailboxId: current.activeMailboxId,
      localView: current.activeLocalView,
      selectedIds: selectedIdsRef.current.slice(),
    };
  }

  function scopeIsCurrent(scope: MutationScope): boolean {
    const current = useAppStore.getState();
    return (
      current.activeAccountId === scope.accountId &&
      current.activeMailboxId === scope.mailboxId &&
      current.activeLocalView === scope.localView
    );
  }

  function selectionIsCurrent(scope: MutationScope): boolean {
    return (
      selectedIdsRef.current.length === scope.selectedIds.length &&
      selectedIdsRef.current.every(
        (id, index) => id === scope.selectedIds[index],
      )
    );
  }

  function selectionScopeIsCurrent(scope: MutationScope): boolean {
    return scopeIsCurrent(scope) && selectionIsCurrent(scope);
  }

  function clearSelectionIfCurrent(scope: MutationScope): boolean {
    if (!selectionScopeIsCurrent(scope)) return false;
    setSelectedIds([]);
    setSelecting(false);
    return true;
  }

  function setScopedError(scope: MutationScope, error: string): void {
    if (scopeIsCurrent(scope)) setError(error);
  }

  function setScopedSelectionError(scope: MutationScope, error: string): void {
    if (selectionScopeIsCurrent(scope)) setError(error);
  }

  function closeOpenMessageIfCurrent(
    scope: MutationScope,
    expected: AppState["selectedMessage"],
  ): boolean {
    if (!expected || !scopeIsCurrent(scope)) return false;
    const open = useAppStore.getState().selectedMessage;
    if (
      open?.id !== expected.id ||
      open.accountId !== expected.accountId ||
      open.mailboxId !== expected.mailboxId
    )
      return false;
    selectMessage(undefined);
    return true;
  }

  function toggleSelectIds(ids: number[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    setSelecting(true);
    selectionAnchor.current = unique[0];
    setSelectedIds((prev) => {
      const chosen = new Set(unique);
      if (unique.every((id) => prev.includes(id))) {
        return prev.filter((id) => !chosen.has(id));
      }
      const next = [...prev];
      for (const id of unique) {
        if (next.includes(id)) continue;
        if (next.length >= 200) {
          setError(strings.mail.bulkTooMany);
          break;
        }
        next.push(id);
      }
      return next;
    });
  }

  function toggleSelectMessage(id: number) {
    selectionAnchor.current = id;
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (prev.length >= 200) {
        setError(strings.mail.bulkTooMany);
        return prev;
      }
      return [...prev, id];
    });
  }

  function selectMessageRange(targetId: number, fallbackAnchorId?: number) {
    if (
      selectionAnchor.current === undefined &&
      fallbackAnchorId !== undefined
    ) {
      selectionAnchor.current = fallbackAnchorId;
    }
    const result = rangeSelection(
      listedMessages.map((message) => message.id),
      selectionAnchor.current,
      targetId,
    );
    if (!result) return;
    if (result.capped) setError(strings.mail.bulkTooMany);
    setSelectedIds(result.ids);
  }

  async function bulkFlags(isRead?: boolean, isStarred?: boolean) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const accountId = activeAccountId;
    const scope = captureMutationScope(accountId);
    const messageIds = scope.selectedIds;
    setBulkBusy(true);
    try {
      const outcome = await api.setMessagesFlags(
        accountId,
        messageIds,
        isRead,
        isStarred,
      );
      if (!scopeIsCurrent(scope)) return;
      if (outcome.failed > 0)
        setScopedSelectionError(
          scope,
          strings.mail.bulkPartial(outcome.failed),
        );
      clearSelectionIfCurrent(scope);
      await refreshList();
      if (!scopeIsCurrent(scope)) return;
      await loadAccountData();
    } catch (cause) {
      setScopedSelectionError(scope, errorText(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteSelectedTrash() {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const mailbox = mailboxes.find((item) => item.id === activeMailboxId);
    if (mailbox?.role !== "trash") return;
    if (selectedIds.length > 200) {
      setError(strings.mail.bulkTooMany);
      return;
    }
    const scope = captureMutationScope(activeAccountId);
    const ids = scope.selectedIds;
    const open = useAppStore.getState().selectedMessage;
    let confirmed: boolean;
    try {
      confirmed = await api.showNativeConfirm(
        strings.mail.deleteForever,
        strings.mail.deleteForeverQuestion(ids.length),
      );
    } catch (cause) {
      setScopedSelectionError(scope, errorText(cause));
      return;
    }
    if (!confirmed || !scopeIsCurrent(scope) || !selectionIsCurrent(scope))
      return;
    setBulkBusy(true);
    try {
      await api.deleteTrashMessages(scope.accountId, ids);
      if (!scopeIsCurrent(scope)) return;
      if (open && ids.includes(open.id)) closeOpenMessageIfCurrent(scope, open);
      clearSelectionIfCurrent(scope);
      await refreshList();
      if (!scopeIsCurrent(scope)) return;
      await loadAccountData();
    } catch (cause) {
      setScopedSelectionError(scope, errorText(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkMove(role: "archive" | "trash" | "junk" | "inbox") {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.role === role,
    );
    if (!destination) {
      setError(strings.mail.noTargetFolder);
      return;
    }
    await bulkMoveTo(destination.id);
  }

  async function bulkMoveTo(mailboxId: number) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.id === mailboxId,
    );
    if (!destination) {
      setError(strings.mail.noTargetFolder);
      return;
    }
    const accountId = activeAccountId;
    const scope = captureMutationScope(accountId);
    const movedIds = scope.selectedIds;
    const open = useAppStore.getState().selectedMessage;
    setBulkBusy(true);
    try {
      const outcome = await undoableMove({
        accountId,
        target: undoTargetFor(destination),
        send: (undoToken) =>
          api.moveMessagesToMailbox(
            accountId,
            movedIds,
            destination.id,
            undoToken,
          ),
        deferred: (result) => result.queued,
      });
      if (!scopeIsCurrent(scope)) return;
      if (outcome.failed > 0)
        setScopedSelectionError(
          scope,
          strings.mail.bulkPartial(outcome.failed),
        );
      // The bulk event names no message, so close a moved open message here.
      if (open && movedIds.includes(open.id))
        closeOpenMessageIfCurrent(scope, open);
      clearSelectionIfCurrent(scope);
      await refreshList();
      if (!scopeIsCurrent(scope)) return;
      await loadAccountData();
    } catch (cause) {
      setScopedSelectionError(scope, errorText(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function pinSelection(pinned: boolean) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      await pinSelectedMessages(activeAccountId, selectedIds, pinned);
    } finally {
      setBulkBusy(false);
    }
  }

  async function snoozeSelection(untilIso: string) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    if (selectedIds.length > 200) {
      setError(strings.mail.bulkTooMany);
      return;
    }
    const accountId = activeAccountId;
    const scope = captureMutationScope(accountId);
    const ids = scope.selectedIds;
    const removed = new Set(ids);
    const current = useAppStore.getState();
    const open = current.selectedMessage;
    const openRemoved = Boolean(
      open && removed.has(open.id) && open.accountId === accountId,
    );
    const next =
      openRemoved && open
        ? messageAfterRemovals(
            current.messages,
            current.settings.groupThreads &&
              (current.mailboxSort ?? "date") === "date",
            removed,
            open.id,
          )
        : undefined;
    setBulkBusy(true);
    let request: number | undefined;
    try {
      await api.snoozeMessages(accountId, ids, untilIso);
      if (!scopeIsCurrent(scope)) return;
      const closedOpen = openRemoved && closeOpenMessageIfCurrent(scope, open);
      if (selectionIsCurrent(scope)) {
        setSelectionSnoozeOpen(false);
        clearSelectionIfCurrent(scope);
      }
      request = closedOpen ? beginMessageOpen() : undefined;
      await loadAccountData();
      if (!scopeIsCurrent(scope)) return;
      await refreshList();
    } catch (cause) {
      setScopedSelectionError(scope, errorText(cause));
      return;
    } finally {
      setBulkBusy(false);
    }
    if (request === undefined || !isCurrentMessageOpen(request)) return;
    const after = useAppStore.getState();
    if (
      after.activeAccountId !== accountId ||
      after.activeMailboxId !== scope.mailboxId ||
      after.activeLocalView !== scope.localView
    )
      return;
    const summary = next
      ? after.messages.find((item) => item.id === next.id)
      : undefined;
    if (summary) await chooseMessage(summary);
  }

  async function bulkCopyTo(mailboxId: number) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.id === mailboxId,
    );
    if (!destination) {
      setError(strings.mail.noTargetFolder);
      return;
    }
    const accountId = activeAccountId;
    const scope = captureMutationScope(accountId);
    const messageIds = scope.selectedIds;
    setBulkBusy(true);
    try {
      const outcome = await api.copyMessagesToMailbox(
        accountId,
        messageIds,
        destination.id,
      );
      if (!scopeIsCurrent(scope)) return;
      if (outcome.failed > 0)
        setScopedSelectionError(
          scope,
          strings.mail.bulkPartial(outcome.failed),
        );
      else if (outcome.queued > 0)
        setScopedSelectionError(scope, strings.mail.copyQueued);
      await loadAccountData();
    } catch (cause) {
      setScopedSelectionError(scope, errorText(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function dropMessages(mailboxId: number, payload: string) {
    if (!activeAccountId || bulkBusy) return;
    const ids = readMessageDrag(payload, activeAccountId);
    if (!ids) return;
    const known = ids.filter((id) =>
      messages.some((message) => message.id === id),
    );
    if (known.length === 0) return;
    if (known.length > 200) {
      setError(strings.mail.bulkTooMany);
      return;
    }
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.id === mailboxId,
    );
    if (!destination || destination.id === activeMailboxId) return;
    const scope = captureMutationScope(activeAccountId);
    const open = useAppStore.getState().selectedMessage;
    const releaseDragged = (id: number) => {
      if (!scopeIsCurrent(scope) || !selectionIsCurrent(scope)) return;
      const next = scope.selectedIds.filter((item) => item !== id);
      setSelectedIds(next);
      if (next.length === 0) setSelecting(false);
    };
    if (
      known.length === 1 &&
      open?.accountId === activeAccountId &&
      open.id === known[0]
    ) {
      releaseDragged(known[0]);
      window.dispatchEvent(
        new CustomEvent("postal:move-mailbox", { detail: destination.id }),
      );
      return;
    }
    setBulkBusy(true);
    try {
      if (known.length === 1) {
        await undoableMove({
          accountId: activeAccountId,
          target: undoTargetFor(destination),
          send: (undoToken) =>
            api.moveMessageToMailbox(
              activeAccountId,
              known[0],
              destination.id,
              undoToken,
            ),
          deferred: () => 1,
        });
        if (!scopeIsCurrent(scope)) return;
        releaseDragged(known[0]);
      } else {
        const outcome = await undoableMove({
          accountId: activeAccountId,
          target: undoTargetFor(destination),
          send: (undoToken) =>
            api.moveMessagesToMailbox(
              activeAccountId,
              known,
              destination.id,
              undoToken,
            ),
          deferred: (result) => result.queued,
        });
        if (!scopeIsCurrent(scope)) return;
        if (outcome.failed > 0)
          setScopedSelectionError(
            scope,
            strings.mail.bulkPartial(outcome.failed),
          );
        clearSelectionIfCurrent(scope);
      }
      if (open && known.includes(open.id))
        closeOpenMessageIfCurrent(scope, open);
      await refreshList();
      if (!scopeIsCurrent(scope)) return;
      await loadAccountData();
    } catch (cause) {
      setScopedSelectionError(scope, errorText(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function markMailboxReadById(mailboxId: number) {
    if (!activeAccountId || bulkBusy) return;
    const accountId = activeAccountId;
    const scope = captureMutationScope(accountId);
    setBulkBusy(true);
    try {
      const outcome = await api.markMailboxRead(accountId, mailboxId);
      if (!scopeIsCurrent(scope)) return;
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      const latest = useAppStore.getState();
      if (
        latest.activeAccountId === accountId &&
        latest.activeMailboxId === mailboxId &&
        !latest.activeLocalView
      ) {
        await refreshList();
      }
      if (!scopeIsCurrent(scope)) return;
      await loadAccountData();
    } catch (cause) {
      setScopedError(scope, errorText(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function markAllRead() {
    if (!activeMailboxId) return;
    await markMailboxReadById(activeMailboxId);
  }

  return {
    toggleSelectIds,
    toggleSelectMessage,
    selectMessageRange,
    bulkFlags,
    deleteSelectedTrash,
    bulkMove,
    bulkMoveTo,
    pinSelection,
    snoozeSelection,
    bulkCopyTo,
    dropMessages,
    markMailboxReadById,
    markAllRead,
  };
}
