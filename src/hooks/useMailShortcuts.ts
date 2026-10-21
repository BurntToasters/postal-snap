import { useEffect, useRef, type RefObject } from "react";
import { TEXT_SCALES } from "../components/settings/displayChoices";
import type { SettingsSaveUpdate } from "../components/settings/useSettingsSave";
import { useAppStore } from "../store";
import {
  inboxMailbox,
  nextUnreadMailbox,
  previousUnreadMailbox,
} from "../components/mail/folderTreeModel";
import { strings } from "../i18n";
import { navigationOrder } from "../threads";
import type { AccountSummary, MessageSummary, ReadingPane } from "../types";
import { emitAction, onAction } from "../actions/bus";
import { matchShortcut } from "../actions/match";
import { unreadMessageStep } from "../actions/registry";
import type { ActionId } from "../actions/types";
import { hasUndoableMove, undoLastMove } from "../undoMove";

export interface MailShortcutsOptions {
  accounts: AccountSummary[];
  selectAccount: (id: string) => void;
  setAccountSwitcherOpen: (open: boolean) => void;
  openComposer: () => void;
  refresh: () => Promise<void>;
  refreshAll: () => Promise<void>;
  onOpenSettings: (tab?: "accounts") => void;
  updateSettings: SettingsSaveUpdate;
  searchInput: RefObject<HTMLInputElement | null>;
  chooseMessage: (msg: MessageSummary) => Promise<unknown>;
  relativeMessage: (delta: number) => MessageSummary | undefined;
  openCommandPalette: () => void;
  openShortcutOverlay: () => void;
}

function archiveShortcutAction(): "archive" | "move-to-inbox" {
  const state = useAppStore.getState();
  const mailbox = state.mailboxes.find(
    (item) => item.id === state.selectedMessage?.mailboxId,
  );
  return mailbox?.role === "archive" ? "move-to-inbox" : "archive";
}

export function useMailShortcuts({
  accounts,
  selectAccount,
  setAccountSwitcherOpen,
  openComposer,
  refresh,
  refreshAll,
  onOpenSettings,
  updateSettings,
  searchInput,
  chooseMessage,
  relativeMessage,
  openCommandPalette,
  openShortcutOverlay,
}: MailShortcutsOptions) {
  const pendingTextScale = useRef<number | null>(null);

  useEffect(() => {
    const menuAction = (action: ActionId) => {
      if (action === "compose") openComposer();
      if (action === "get-mail") void refresh();
      if (action === "get-mail-all") void refreshAll();
      if (action === "settings") onOpenSettings();
      if (action === "open-command-palette") openCommandPalette();
      if (action === "show-shortcuts") openShortcutOverlay();
      if (action === "undo") undoLastMove();
      if (action === "search") {
        searchInput.current?.focus();
        searchInput.current?.select();
      }
      if (action === "next-unread" || action === "previous-unread") {
        const next = unreadMessageStep(action);
        if (next) void chooseMessage(next);
      }
      if (action === "go-to-inbox") {
        const state = useAppStore.getState();
        const inbox = inboxMailbox(state.mailboxes);
        if (!inbox) {
          state.setError(strings.mail.noInbox);
          return;
        }
        if (inbox.id === state.activeMailboxId && !state.activeLocalView)
          return;
        state.selectMailbox(inbox.id);
      }
      if (
        action === "next-unread-mailbox" ||
        action === "previous-unread-mailbox"
      ) {
        const state = useAppStore.getState();
        const next =
          action === "next-unread-mailbox"
            ? nextUnreadMailbox(state.mailboxes, state.activeMailboxId)
            : previousUnreadMailbox(state.mailboxes, state.activeMailboxId);
        if (!next) {
          state.setError(strings.mail.noOtherUnreadMailbox);
          return;
        }
        state.selectMailbox(next.id);
      }
      if (
        action === "text-larger" ||
        action === "text-smaller" ||
        action === "text-size-larger" ||
        action === "text-size-smaller"
      ) {
        const scales = TEXT_SCALES;
        const requestedScale = pendingTextScale.current;
        const currentScale =
          requestedScale ?? useAppStore.getState().settings.textScale;
        const current = scales.reduce(
          (closest, value) =>
            Math.abs(value - currentScale) < Math.abs(closest - currentScale)
              ? value
              : closest,
          1,
        );
        const currentIndex = scales.indexOf(current);
        const delta =
          action === "text-larger" || action === "text-size-larger" ? 1 : -1;
        const nextIndex = Math.max(
          0,
          Math.min(scales.length - 1, currentIndex + delta),
        );
        const nextScale = scales[nextIndex];
        pendingTextScale.current = nextScale;
        void updateSettings({ textScale: nextScale }).finally(() => {
          if (pendingTextScale.current === nextScale) {
            pendingTextScale.current = null;
          }
        });
      }
      if (
        action === "reading-pane-right" ||
        action === "reading-pane-bottom" ||
        action === "reading-pane-hidden"
      ) {
        const readingPane: ReadingPane =
          action === "reading-pane-right"
            ? "right"
            : action === "reading-pane-bottom"
              ? "bottom"
              : "hidden";
        void updateSettings({ readingPane });
      }
    };

    // The matcher applies the typing, dialog, and chrome-control guards.
    const keyboard = (event: KeyboardEvent) => {
      const id = matchShortcut(event);
      if (!id) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // List rows own arrows/Space/Home/End/j/k through roving tabindex.
      const inMessageList = Boolean(
        target?.closest('[role="listbox"], [role="tree"]'),
      );

      switch (id) {
        case "select-account": {
          const account = accounts[Number(event.key) - 1];
          if (!account) return;
          event.preventDefault();
          setAccountSwitcherOpen(false);
          selectAccount(account.id);
          return;
        }
        case "new-message":
          event.preventDefault();
          openComposer();
          return;
        case "get-mail":
          event.preventDefault();
          void refresh();
          return;
        case "get-mail-all":
          event.preventDefault();
          void refreshAll();
          return;
        case "reply":
          // Mod+R prefers the reply mode from settings, not plain Reply.
          event.preventDefault();
          emitAction("reply-preferred");
          return;
        case "reply-all":
        case "forward":
        case "junk":
        case "toggle-read":
        case "toggle-star":
        case "reading-pane-right":
        case "reading-pane-bottom":
        case "reading-pane-hidden":
          event.preventDefault();
          emitAction(id);
          return;
        case "archive":
          event.preventDefault();
          emitAction(archiveShortcutAction());
          return;
        case "find-in-message":
          event.preventDefault();
          window.dispatchEvent(new Event("postal:find-in-message"));
          return;
        case "search":
        case "open-command-palette":
        case "show-shortcuts":
        case "go-to-inbox":
        case "next-unread-mailbox":
        case "previous-unread-mailbox":
          event.preventDefault();
          emitAction(id);
          return;
        case "undo":
          if (!hasUndoableMove()) return;
          event.preventDefault();
          emitAction("undo");
          return;
        case "next-unread":
        case "previous-unread":
          if (!unreadMessageStep(id)) return;
          event.preventDefault();
          emitAction(id);
          return;
        case "reply-focused":
        case "reply-all-focused": {
          if (inMessageList) return;
          if (!useAppStore.getState().selectedMessage) return;
          event.preventDefault();
          emitAction(id === "reply-focused" ? "reply-preferred" : "reply-all");
          return;
        }
        case "delete-msg":
        case "trash": {
          const state = useAppStore.getState();
          const current = state.selectedMessage;
          if (!current) return;
          const mailbox = state.mailboxes.find(
            (item) => item.id === current.mailboxId,
          );
          if (mailbox?.role === "trash") {
            event.preventDefault();
            emitAction("delete-forever");
            return;
          }
          const trashBox = state.mailboxes.find((m) => m.role === "trash");
          if (trashBox && trashBox.id !== current.mailboxId) {
            event.preventDefault();
            emitAction("trash");
          }
          return;
        }
        case "next-message":
        case "prev-message": {
          if (inMessageList) return;
          const next = relativeMessage(id === "next-message" ? 1 : -1);
          if (!next) return;
          event.preventDefault();
          void chooseMessage(next);
          return;
        }
        case "first-last": {
          if (inMessageList) return;
          const state = useAppStore.getState();
          const items = navigationOrder(
            state.messages,
            state.settings.groupThreads,
          );
          const edge =
            event.key === "Home" ? items[0] : items[items.length - 1];
          if (!edge) return;
          event.preventDefault();
          void chooseMessage(edge);
          return;
        }
        case "scroll-reader":
          if (inMessageList) return;
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent("postal:scroll-reader", {
              detail: event.shiftKey ? -1 : 1,
            }),
          );
          return;
        default:
          return;
      }
    };

    const unsubscribeAction = onAction(menuAction);
    window.addEventListener("keydown", keyboard);
    return () => {
      unsubscribeAction();
      window.removeEventListener("keydown", keyboard);
    };
  }, [
    accounts,
    chooseMessage,
    onOpenSettings,
    openComposer,
    openCommandPalette,
    openShortcutOverlay,
    refresh,
    refreshAll,
    relativeMessage,
    searchInput,
    selectAccount,
    setAccountSwitcherOpen,
    updateSettings,
  ]);
}
