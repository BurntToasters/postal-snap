import { useEffect, useRef, type RefObject } from "react";
import { TEXT_SCALES } from "../components/settings/displayChoices";
import type { SettingsSaveUpdate } from "../components/settings/useSettingsSave";
import { useAppStore } from "../store";
import {
  inboxMailbox,
  nextUnreadMailbox,
  previousUnreadMailbox,
} from "../components/mail/folderTree";
import { strings } from "../i18n";
import { navigationOrder, unreadStep } from "../threads";
import type { AccountSummary, MessageSummary, ReadingPane } from "../types";

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
}: MailShortcutsOptions) {
  const pendingTextScale = useRef<number | null>(null);

  useEffect(() => {
    const menuAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action === "compose") openComposer();
      if (action === "get-mail") void refresh();
      if (action === "get-mail-all") void refreshAll();
      if (action === "settings") onOpenSettings();
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

    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (document.querySelector(".modal-layer")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isEditing = Boolean(
        target?.matches(
          "input,textarea,select,[contenteditable='true'],[role='combobox'],[role='textbox']",
        ),
      );
      const onChromeControl = Boolean(
        target?.closest(
          "button, a, [role='menuitem'], .reader-actions, .format-toolbar, .settings-nav, .bulk-bar",
        ) && !target?.closest(".message-list"),
      );
      // macOS: Control keys are text editing (Ctrl+E ends the line), so only
      // Command is the shortcut modifier there.
      const mod =
        document.documentElement.dataset.platform === "macos"
          ? event.metaKey
          : event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        /^[1-9]$/.test(event.key)
      ) {
        const account = accounts[Number(event.key) - 1];
        if (account) {
          event.preventDefault();
          setAccountSwitcherOpen(false);
          selectAccount(account.id);
        }
        return;
      }

      if (mod && !event.shiftKey && key === "n") {
        event.preventDefault();
        openComposer();
        return;
      }
      if (event.key === "F5" && event.shiftKey && !mod && !event.altKey) {
        event.preventDefault();
        void refreshAll();
        return;
      }
      if (
        (mod && event.shiftKey && key === "m") ||
        (mod && event.shiftKey && key === "n") ||
        event.key === "F5"
      ) {
        event.preventDefault();
        void refresh();
        return;
      }
      if (mod && !event.shiftKey && key === "r") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "reply-preferred" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "r") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "reply-all" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "f") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "forward" }),
        );
        return;
      }
      if (mod && !event.shiftKey && key === "e") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", {
            detail: archiveShortcutAction(),
          }),
        );
        return;
      }
      if (event.ctrlKey && event.metaKey && key === "a") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", {
            detail: archiveShortcutAction(),
          }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "u") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "toggle-read" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "l") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "toggle-star" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "j") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "junk" }),
        );
        return;
      }
      if (
        mod &&
        event.altKey &&
        (event.key === "ArrowRight" || event.key === "Right")
      ) {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", {
            detail: "reading-pane-right",
          }),
        );
        return;
      }
      if (
        mod &&
        event.altKey &&
        (event.key === "ArrowDown" || event.key === "Down")
      ) {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", {
            detail: "reading-pane-bottom",
          }),
        );
        return;
      }
      if (
        mod &&
        event.altKey &&
        (event.key === "ArrowUp" || event.key === "Up")
      ) {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", {
            detail: "reading-pane-hidden",
          }),
        );
        return;
      }
      if (mod && event.altKey && key === "f") {
        event.preventDefault();
        window.dispatchEvent(new Event("postal:find-in-message"));
        return;
      }
      if (
        (event.key === "/" && !mod && !isEditing) ||
        (mod && !event.shiftKey && !event.altKey && key === "f")
      ) {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      if (isEditing || onChromeControl) return;
      if (
        !mod &&
        !event.altKey &&
        !event.shiftKey &&
        (key === "n" || key === "p")
      ) {
        const state = useAppStore.getState();
        const next = unreadStep(
          state.messages,
          state.settings.groupThreads &&
            (state.mailboxSort ?? "date") === "date",
          state.selectedMessage?.id,
          key === "n" ? 1 : -1,
        );
        if (!next) return;
        event.preventDefault();
        void chooseMessage(next);
        return;
      }
      if (!mod && !event.altKey && !event.shiftKey && key === "i") {
        const state = useAppStore.getState();
        const inbox = inboxMailbox(state.mailboxes);
        event.preventDefault();
        if (!inbox) {
          state.setError(strings.mail.noInbox);
          return;
        }
        if (inbox.id === state.activeMailboxId && !state.activeLocalView)
          return;
        state.selectMailbox(inbox.id);
        return;
      }
      if (
        !mod &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "]" || event.key === "[")
      ) {
        const state = useAppStore.getState();
        const next =
          event.key === "]"
            ? nextUnreadMailbox(state.mailboxes, state.activeMailboxId)
            : previousUnreadMailbox(state.mailboxes, state.activeMailboxId);
        event.preventDefault();
        if (!next) {
          state.setError(strings.mail.noOtherUnreadMailbox);
          return;
        }
        state.selectMailbox(next.id);
        return;
      }
      // List rows own arrows/Space/Home/End/j/k through roving tabindex.
      // The global handler must not double-handle them when focus is in list.
      const inMessageList = Boolean(
        target?.closest('[role="listbox"], [role="tree"]'),
      );

      if (
        !mod &&
        !event.altKey &&
        !event.shiftKey &&
        (key === "r" || key === "a") &&
        !inMessageList
      ) {
        const selected = useAppStore.getState().selectedMessage;
        if (selected) {
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent("postal:menu-action", {
              detail: key === "a" ? "reply-all" : "reply-preferred",
            }),
          );
        }
        return;
      }
      if (event.key === "Delete" || (mod && event.key === "Backspace")) {
        const state = useAppStore.getState();
        const currentMsg = state.selectedMessage;
        if (currentMsg) {
          const mailbox = state.mailboxes.find(
            (item) => item.id === currentMsg.mailboxId,
          );
          if (mailbox?.role === "trash") {
            event.preventDefault();
            window.dispatchEvent(
              new CustomEvent("postal:menu-action", {
                detail: "delete-forever",
              }),
            );
          } else {
            const trashBox = state.mailboxes.find((m) => m.role === "trash");
            if (trashBox && trashBox.id !== currentMsg.mailboxId) {
              event.preventDefault();
              window.dispatchEvent(
                new CustomEvent("postal:menu-action", { detail: "trash" }),
              );
            }
          }
        }
      } else if (event.key === "ArrowDown" || event.key === "j") {
        if (inMessageList) return;
        const next = relativeMessage(1);
        if (next) {
          event.preventDefault();
          void chooseMessage(next);
        }
      } else if (event.key === "ArrowUp" || event.key === "k") {
        if (inMessageList) return;
        const previous = relativeMessage(-1);
        if (previous) {
          event.preventDefault();
          void chooseMessage(previous);
        }
      } else if (event.key === "Home") {
        if (inMessageList) return;
        const state = useAppStore.getState();
        const first = navigationOrder(
          state.messages,
          state.settings.groupThreads,
        )[0];
        if (first) {
          event.preventDefault();
          void chooseMessage(first);
        }
      } else if (event.key === "End") {
        if (inMessageList) return;
        const state = useAppStore.getState();
        const items = navigationOrder(
          state.messages,
          state.settings.groupThreads,
        );
        const last = items[items.length - 1];
        if (last) {
          event.preventDefault();
          void chooseMessage(last);
        }
      } else if (event.key === " " || event.code === "Space") {
        if (inMessageList) return;
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:scroll-reader", {
            detail: event.shiftKey ? -1 : 1,
          }),
        );
      }
    };

    window.addEventListener("postal:menu-action", menuAction);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("postal:menu-action", menuAction);
      window.removeEventListener("keydown", keyboard);
    };
  }, [
    accounts,
    chooseMessage,
    onOpenSettings,
    openComposer,
    refresh,
    refreshAll,
    relativeMessage,
    searchInput,
    selectAccount,
    setAccountSwitcherOpen,
    updateSettings,
  ]);
}
