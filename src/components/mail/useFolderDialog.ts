import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { mailboxIsPinned, unpinMailbox } from "../../pinnedMailboxes";
import { useSettingsSave } from "../settings/useSettingsSave";

type AppState = ReturnType<typeof useAppStore.getState>;

export type FolderDialogState =
  | null
  | { mode: "create"; parentId?: number; parentLabel?: string }
  | { mode: "rename"; id: number; name: string; parentLabel?: string };

interface Options {
  activeAccountId: AppState["activeAccountId"];
  folderDialog: FolderDialogState;
  setFolderDialog: Dispatch<SetStateAction<FolderDialogState>>;
  folderName: string;
  setFolderName: Dispatch<SetStateAction<string>>;
  folderBusy: boolean;
  setFolderBusy: Dispatch<SetStateAction<boolean>>;
  moveFolderId: number | null;
  setMoveFolderId: Dispatch<SetStateAction<number | null>>;
  newFolderButtonRef: RefObject<HTMLButtonElement | null>;
  lastFolderInvoker: MutableRefObject<HTMLElement | null>;
  loadAccountData: () => Promise<void>;
  updateSettings: ReturnType<typeof useSettingsSave>["update"];
  setError: AppState["setError"];
}

export function useFolderDialog({
  activeAccountId,
  folderDialog,
  setFolderDialog,
  folderName,
  setFolderName,
  folderBusy,
  setFolderBusy,
  moveFolderId,
  setMoveFolderId,
  newFolderButtonRef,
  lastFolderInvoker,
  loadAccountData,
  updateSettings,
  setError,
}: Options) {
  function openFolderDialog(
    dialog:
      | { mode: "create"; parentId?: number; parentLabel?: string }
      | { mode: "rename"; id: number; name: string; parentLabel?: string },
  ) {
    lastFolderInvoker.current =
      dialog.mode === "create"
        ? newFolderButtonRef.current
        : (document.activeElement as HTMLElement | null);
    setFolderName(dialog.mode === "rename" ? dialog.name : "");
    setFolderDialog(dialog);
  }

  function closeFolderDialog() {
    setFolderDialog(null);
    setFolderName("");
    lastFolderInvoker.current?.focus();
  }

  function folderDialogKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFolderDialog();
    }
  }

  async function submitFolderDialog() {
    if (!activeAccountId || folderBusy) return;
    const name = folderName.trim();
    if (!name) return;
    setFolderBusy(true);
    try {
      if (folderDialog?.mode === "rename") {
        await api.renameFolder(activeAccountId, folderDialog.id, name);
      } else {
        const parentId =
          folderDialog?.mode === "create" ? folderDialog.parentId : undefined;
        if (parentId == null) await api.createFolder(activeAccountId, name);
        else await api.createFolder(activeAccountId, name, parentId);
        if (
          parentId != null &&
          mailboxIsPinned(
            useAppStore.getState().settings.collapsedMailboxes,
            activeAccountId,
            parentId,
          )
        ) {
          void updateSettings({
            collapsedMailboxes: unpinMailbox(
              useAppStore.getState().settings.collapsedMailboxes,
              activeAccountId,
              parentId,
            ),
          });
        }
      }
      closeFolderDialog();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setFolderBusy(false);
    }
  }

  async function submitMoveFolder(parentId: number | null) {
    if (!activeAccountId || moveFolderId == null || folderBusy) return;
    const accountId = activeAccountId;
    const mailboxId = moveFolderId;
    setFolderBusy(true);
    try {
      if (parentId == null) await api.moveFolder(accountId, mailboxId);
      else await api.moveFolder(accountId, mailboxId, parentId);
      setMoveFolderId(null);
      if (
        parentId != null &&
        mailboxIsPinned(
          useAppStore.getState().settings.collapsedMailboxes,
          accountId,
          parentId,
        )
      ) {
        void updateSettings({
          collapsedMailboxes: unpinMailbox(
            useAppStore.getState().settings.collapsedMailboxes,
            accountId,
            parentId,
          ),
        });
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setFolderBusy(false);
    }
  }

  async function deleteFolderById(id: number, label: string) {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.appName,
      strings.mail.deleteFolderQuestion(label),
    );
    if (!confirmed) return;
    try {
      await api.deleteFolder(activeAccountId, id);
      const latest = useAppStore.getState();
      if (
        mailboxIsPinned(latest.settings.pinnedMailboxes, activeAccountId, id)
      ) {
        void updateSettings({
          pinnedMailboxes: unpinMailbox(
            latest.settings.pinnedMailboxes,
            activeAccountId,
            id,
          ),
        });
      }
      if (latest.settings.recentMoveMailboxId === id) {
        void updateSettings({ recentMoveMailboxId: null });
      }
      if (
        mailboxIsPinned(latest.settings.hiddenMailboxes, activeAccountId, id)
      ) {
        void updateSettings({
          hiddenMailboxes: unpinMailbox(
            latest.settings.hiddenMailboxes,
            activeAccountId,
            id,
          ),
        });
      }
      if (
        mailboxIsPinned(latest.settings.collapsedMailboxes, activeAccountId, id)
      ) {
        void updateSettings({
          collapsedMailboxes: unpinMailbox(
            latest.settings.collapsedMailboxes,
            activeAccountId,
            id,
          ),
        });
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function emptyTrashFolders() {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.appName,
      strings.mail.emptyTrashQuestion,
    );
    if (!confirmed) return;
    try {
      await api.emptyTrash(activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function emptyJunkFolders() {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.appName,
      strings.mail.emptyJunkQuestion,
    );
    if (!confirmed) return;
    try {
      await api.emptyJunk(activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  return {
    openFolderDialog,
    closeFolderDialog,
    folderDialogKeyDown,
    submitFolderDialog,
    submitMoveFolder,
    deleteFolderById,
    emptyTrashFolders,
    emptyJunkFolders,
  };
}
