import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
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

type AppState = ReturnType<typeof useAppStore.getState>;

interface Options {
  activeAccountId: AppState["activeAccountId"];
  activeMailboxId: AppState["activeMailboxId"];
  mailboxes: AppState["mailboxes"];
  messages: AppState["messages"];
  listedMessages: MessageSummary[];
  setError: AppState["setError"];
  selectMessage: AppState["selectMessage"];
  refreshList: () => Promise<void>;
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
    setBulkBusy(true);
    try {
      const outcome = await api.setMessagesFlags(
        activeAccountId,
        selectedIds,
        isRead,
        isStarred,
      );
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      setSelectedIds([]);
      setSelecting(false);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
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
    const ids = selectedIds.slice();
    const confirmed = await api.showNativeConfirm(
      strings.mail.deleteForever,
      strings.mail.deleteForeverQuestion(ids.length),
    );
    if (!confirmed) return;
    const latest = useAppStore.getState();
    if (
      latest.activeAccountId !== activeAccountId ||
      latest.activeMailboxId !== activeMailboxId
    )
      return;
    setBulkBusy(true);
    try {
      await api.deleteTrashMessages(activeAccountId, ids);
      const open = useAppStore.getState().selectedMessage;
      if (open && ids.includes(open.id)) selectMessage(undefined);
      setSelectedIds([]);
      setSelecting(false);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
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
    setBulkBusy(true);
    try {
      const movedIds = selectedIds;
      const outcome = await api.moveMessagesToMailbox(
        activeAccountId,
        movedIds,
        destination.id,
      );
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      // The bulk event names no message, so close a moved open message here.
      const open = useAppStore.getState().selectedMessage;
      if (open && movedIds.includes(open.id)) selectMessage(undefined);
      setSelectedIds([]);
      setSelecting(false);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
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
    const ids = selectedIds.slice();
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
    try {
      await api.snoozeMessages(accountId, ids, untilIso);
    } catch (cause) {
      setError(String(cause));
      setBulkBusy(false);
      return;
    }
    if (openRemoved) selectMessage(undefined);
    setSelectionSnoozeOpen(false);
    setSelectedIds([]);
    setSelecting(false);
    const request = openRemoved ? beginMessageOpen() : undefined;
    try {
      await loadAccountData();
      await refreshList();
    } catch (cause) {
      setError(String(cause));
      return;
    } finally {
      setBulkBusy(false);
    }
    if (request === undefined || !isCurrentMessageOpen(request)) return;
    const after = useAppStore.getState();
    if (after.activeAccountId !== accountId || after.activeLocalView) return;
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
    setBulkBusy(true);
    try {
      const outcome = await api.copyMessagesToMailbox(
        activeAccountId,
        selectedIds,
        destination.id,
      );
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      else if (outcome.queued > 0) setError(strings.mail.copyQueued);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
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
    const open = useAppStore.getState().selectedMessage;
    const releaseDragged = (id: number) => {
      setSelectedIds((current) => {
        const next = current.filter((item) => item !== id);
        if (next.length === 0) setSelecting(false);
        return next;
      });
    };
    if (known.length === 1 && open?.id === known[0]) {
      releaseDragged(known[0]);
      window.dispatchEvent(
        new CustomEvent("postal:move-mailbox", { detail: destination.id }),
      );
      return;
    }
    setBulkBusy(true);
    try {
      if (known.length === 1) {
        await api.moveMessageToMailbox(
          activeAccountId,
          known[0],
          destination.id,
        );
        releaseDragged(known[0]);
      } else {
        const outcome = await api.moveMessagesToMailbox(
          activeAccountId,
          known,
          destination.id,
        );
        if (outcome.failed > 0)
          setError(strings.mail.bulkPartial(outcome.failed));
        setSelectedIds([]);
        setSelecting(false);
      }
      if (open && known.includes(open.id)) selectMessage(undefined);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function markMailboxReadById(mailboxId: number) {
    if (!activeAccountId || bulkBusy) return;
    const accountId = activeAccountId;
    setBulkBusy(true);
    try {
      const outcome = await api.markMailboxRead(accountId, mailboxId);
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
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
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
