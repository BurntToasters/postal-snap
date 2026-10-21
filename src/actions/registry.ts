import {
  inboxMailbox,
  nextUnreadMailbox,
  previousUnreadMailbox,
} from "../components/mail/folderTreeModel";
import { shortcutAltMod, shortcutMod, shortcutShiftMod } from "../format";
import { strings } from "../i18n";
import { useAppStore } from "../store";
import { unreadStep } from "../threads";
import type { MailboxRole, MessageSummary } from "../types";
import { hasUndoableMove } from "../undoMove";
import { emitAction } from "./bus";
import type { ActionDefinition, ActionId } from "./types";

// Array order is display order and breaks ties when two bindings match equally.
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function controlLabel(): string {
  return document.documentElement.dataset.platform === "macos" ? "⌃" : "Ctrl";
}

const app = () => useAppStore.getState();

/** Runs through the same "postal:menu-action" bus as native menus. */
const viaBus = (id: ActionId) => () => emitAction(id);

function hasAccount(): boolean {
  return app().accounts.length > 0;
}

function hasSelection(): boolean {
  return app().selectedMessage !== undefined;
}

function selectedRole(): MailboxRole | undefined {
  const state = app();
  const message = state.selectedMessage;
  if (!message) return undefined;
  return state.mailboxes.find((box) => box.id === message.mailboxId)?.role;
}

function trashTargetExists(): boolean {
  const state = app();
  const current = state.selectedMessage;
  return Boolean(
    current &&
    state.mailboxes.some(
      (box) => box.role === "trash" && box.id !== current.mailboxId,
    ),
  );
}

function inboxAvailable(): boolean {
  const state = app();
  const inbox = inboxMailbox(state.mailboxes);
  if (!inbox) return false;
  return !(inbox.id === state.activeMailboxId && !state.activeLocalView);
}

/** Next or previous unread message in the keyboard's navigation order. */
export function unreadMessageStep(
  id: "next-unread" | "previous-unread",
): MessageSummary | undefined {
  const state = app();
  return unreadStep(
    state.messages,
    state.settings.groupThreads && (state.mailboxSort ?? "date") === "date",
    state.selectedMessage?.id,
    id === "next-unread" ? 1 : -1,
  );
}

function unreadMailboxAvailable(
  id: "next-unread-mailbox" | "previous-unread-mailbox",
): boolean {
  const state = app();
  const next =
    id === "next-unread-mailbox"
      ? nextUnreadMailbox(state.mailboxes, state.activeMailboxId)
      : previousUnreadMailbox(state.mailboxes, state.activeMailboxId);
  return next !== undefined;
}

const ACTIONS: readonly ActionDefinition[] = [
  {
    id: "new-message",
    run: () => app().openComposer(),
    available: hasAccount,
    label: () => strings.composer.newMessage,
    scope: "global",
    shortcut: [{ key: "n", mod: true, shift: false, focus: "any" }],
    hint: () => `${shortcutMod()} N`,
  },
  {
    id: "get-mail",
    run: viaBus("get-mail"),
    available: hasAccount,
    label: () => strings.mail.getMail,
    scope: "global",
    shortcut: [
      { key: "n", mod: true, shift: true, focus: "any" },
      { key: "m", mod: true, shift: true, focus: "any" },
      { key: "F5", focus: "any" },
    ],
    hint: () => `${shortcutShiftMod()} N`,
  },
  {
    id: "get-mail-all",
    run: viaBus("get-mail-all"),
    available: hasAccount,
    label: () => strings.mail.getMailAllAccounts,
    scope: "global",
    shortcut: [
      { key: "F5", shift: true, mod: false, alt: false, focus: "any" },
    ],
    hint: () => "⇧ F5",
  },
  {
    id: "reply",
    // Palette and Cmd+R agree on the reply the reader prefers.
    run: viaBus("reply-preferred"),
    available: hasSelection,
    label: () => strings.reader.reply,
    scope: "reader",
    shortcut: [{ key: "r", mod: true, shift: false, focus: "any" }],
    hint: () => `${shortcutMod()} R`,
  },
  {
    id: "reply-all",
    run: viaBus("reply-all"),
    available: hasSelection,
    label: () => strings.reader.replyAll,
    scope: "reader",
    shortcut: [{ key: "r", mod: true, shift: true, focus: "any" }],
    hint: () => `${shortcutShiftMod()} R`,
  },
  {
    id: "forward",
    run: viaBus("forward"),
    available: hasSelection,
    label: () => strings.reader.forward,
    scope: "reader",
    shortcut: [{ key: "f", mod: true, shift: true, focus: "any" }],
    hint: () => `${shortcutShiftMod()} F`,
  },
  {
    id: "archive",
    run: viaBus("archive"),
    available: () => hasSelection() && selectedRole() !== "archive",
    label: () => strings.reader.archive,
    scope: "reader",
    // Ctrl+Cmd+A is an unlisted alias for archive on macOS.
    shortcut: [
      { key: "e", mod: true, shift: false, focus: "any" },
      { key: "a", ctrl: true, meta: true, focus: "any" },
    ],
    hint: () => `${shortcutMod()} E`,
  },
  {
    id: "trash",
    run: viaBus("trash"),
    available: () =>
      hasSelection() && selectedRole() !== "trash" && trashTargetExists(),
    label: () => strings.reader.trash,
    scope: "reader",
    shortcut: [{ key: "Backspace", mod: true }],
    hint: () => `${shortcutMod()} ⌫`,
  },
  {
    id: "search",
    run: viaBus("search"),
    available: hasAccount,
    label: () => strings.mail.search,
    scope: "global",
    shortcut: [
      { key: "f", mod: true, shift: false, alt: false, focus: "any" },
      { key: "/", mod: false, shift: false, focus: "not-editing" },
    ],
    hint: () => `${shortcutMod()} F / /`,
  },
  {
    id: "find-in-message",
    run: viaBus("find-in-message"),
    available: hasSelection,
    label: () => strings.reader.findInMessage,
    scope: "reader",
    shortcut: [{ key: "f", mod: true, alt: true, focus: "any" }],
    hint: () => `${shortcutAltMod()} F`,
  },
  {
    id: "send",
    label: () => strings.composer.send,
    scope: "composer",
    hint: () => `${shortcutMod()} ↵`,
  },
  {
    id: "save-draft",
    label: () => strings.composer.saveDraft,
    scope: "composer",
    hint: () => `${shortcutMod()} S`,
  },
  {
    id: "text-size",
    label: () => strings.settings.textSize,
    scope: "global",
    hint: () => `${shortcutMod()} + / ${shortcutMod()} -`,
  },
  {
    id: "settings",
    keywords: ["preferences", "options"],
    run: viaBus("settings"),
    label: () => strings.mail.settings,
    scope: "global",
    hint: () => `${shortcutMod()} ,`,
  },
  {
    id: "next-unread",
    run: viaBus("next-unread"),
    available: () => unreadMessageStep("next-unread") !== undefined,
    label: () => strings.settings.shortcutNextUnread,
    scope: "list",
    shortcut: [{ key: "n", mod: false, alt: false, shift: false }],
    hint: () => "n",
  },
  {
    id: "go-to-inbox",
    run: viaBus("go-to-inbox"),
    available: inboxAvailable,
    label: () => strings.settings.shortcutGoToInbox,
    scope: "global",
    shortcut: [{ key: "i", mod: false, alt: false, shift: false }],
    hint: () => "i",
  },
  {
    id: "next-unread-mailbox",
    run: viaBus("next-unread-mailbox"),
    available: () =>
      hasAccount() && unreadMailboxAvailable("next-unread-mailbox"),
    label: () => strings.settings.shortcutNextUnreadMailbox,
    scope: "global",
    shortcut: [{ key: "]", mod: false, alt: false, shift: false }],
    hint: () => "]",
  },
  {
    id: "previous-unread-mailbox",
    run: viaBus("previous-unread-mailbox"),
    available: () =>
      hasAccount() && unreadMailboxAvailable("previous-unread-mailbox"),
    label: () => strings.settings.shortcutPreviousUnreadMailbox,
    scope: "global",
    shortcut: [{ key: "[", mod: false, alt: false, shift: false }],
    hint: () => "[",
  },
  {
    id: "previous-unread",
    run: viaBus("previous-unread"),
    available: () => unreadMessageStep("previous-unread") !== undefined,
    label: () => strings.settings.shortcutPreviousUnread,
    scope: "list",
    shortcut: [{ key: "p", mod: false, alt: false, shift: false }],
    hint: () => "p",
  },
  {
    id: "next-message",
    label: () => strings.settings.shortcutNextMessage,
    scope: "list",
    shortcut: [{ key: ["ArrowDown", "j"] }],
    hint: () => "j / ↓",
  },
  {
    id: "prev-message",
    label: () => strings.settings.shortcutPreviousMessage,
    scope: "list",
    shortcut: [{ key: ["ArrowUp", "k"] }],
    hint: () => "k / ↑",
  },
  {
    id: "first-last",
    label: () => strings.settings.shortcutFirstLastMessage,
    scope: "list",
    shortcut: [{ key: ["Home", "End"] }],
    hint: () => "Home / End",
  },
  {
    id: "scroll-reader",
    label: () => strings.settings.shortcutScrollReader,
    scope: "reader",
    shortcut: [{ key: " ", code: "Space" }],
    hint: () => "Space / ⇧ Space",
  },
  {
    id: "delete-msg",
    label: () => strings.reader.trash,
    scope: "reader",
    shortcut: [{ key: "Delete" }],
    hint: () => "Delete",
  },
  {
    id: "toggle-read",
    run: viaBus("toggle-read"),
    available: hasSelection,
    label: () => strings.settings.shortcutMarkReadUnread,
    scope: "reader",
    shortcut: [{ key: "u", mod: true, shift: true, focus: "any" }],
    hint: () => `${shortcutShiftMod()} U`,
  },
  {
    id: "toggle-star",
    run: viaBus("toggle-star"),
    available: hasSelection,
    label: () => strings.settings.shortcutStarMessage,
    scope: "reader",
    shortcut: [{ key: "l", mod: true, shift: true, focus: "any" }],
    hint: () => `${shortcutShiftMod()} L`,
  },
  {
    id: "star-focused",
    label: () => strings.settings.shortcutStarFocused,
    scope: "list",
    hint: () => "s",
  },
  {
    id: "read-focused",
    label: () => strings.settings.shortcutReadFocused,
    scope: "list",
    hint: () => "u",
  },
  {
    id: "check-focused",
    label: () => strings.settings.shortcutCheckFocused,
    scope: "list",
    hint: () => "x",
  },
  {
    id: "archive-focused",
    label: () => strings.settings.shortcutArchiveFocused,
    scope: "list",
    hint: () => "e",
  },
  {
    id: "trash-focused",
    label: () => strings.settings.shortcutTrashFocused,
    scope: "list",
    hint: () => "Delete / #",
  },
  {
    id: "junk-focused",
    label: () => strings.settings.shortcutJunkFocused,
    scope: "list",
    hint: () => "!",
  },
  {
    id: "reply-focused",
    label: () => strings.settings.shortcutReplyFocused,
    scope: "reader",
    shortcut: [{ key: "r", mod: false, alt: false, shift: false }],
    hint: () => "r",
  },
  {
    id: "reply-all-focused",
    label: () => strings.settings.shortcutReplyAllFocused,
    scope: "reader",
    shortcut: [{ key: "a", mod: false, alt: false, shift: false }],
    hint: () => "a",
  },
  {
    id: "print",
    run: viaBus("print"),
    available: hasSelection,
    label: () => strings.reader.print,
    scope: "reader",
    hint: () => `${shortcutMod()} P`,
  },
  {
    id: "select-account",
    label: () => strings.settings.shortcutSwitchAccount,
    scope: "global",
    shortcut: [
      {
        key: DIGITS,
        ctrl: true,
        meta: false,
        shift: false,
        alt: false,
        focus: "any",
      },
    ],
    hint: () => `${controlLabel()} 1–9`,
  },
  {
    id: "junk",
    run: viaBus("junk"),
    available: () => hasSelection() && selectedRole() !== "junk",
    label: () => strings.reader.junk,
    scope: "reader",
    shortcut: [{ key: "j", mod: true, shift: true, focus: "any" }],
    hint: () => `${shortcutShiftMod()} J`,
  },
  {
    id: "reading-pane-right",
    run: viaBus("reading-pane-right"),
    label: () => strings.settings.shortcutReadingPaneRight,
    scope: "global",
    shortcut: [
      { key: ["ArrowRight", "Right"], mod: true, alt: true, focus: "any" },
    ],
    hint: () => `${shortcutAltMod()} →`,
  },
  {
    id: "reading-pane-bottom",
    run: viaBus("reading-pane-bottom"),
    label: () => strings.settings.shortcutReadingPaneBottom,
    scope: "global",
    shortcut: [
      { key: ["ArrowDown", "Down"], mod: true, alt: true, focus: "any" },
    ],
    hint: () => `${shortcutAltMod()} ↓`,
  },
  {
    id: "reading-pane-hidden",
    run: viaBus("reading-pane-hidden"),
    label: () => strings.settings.shortcutReadingPaneHidden,
    scope: "global",
    shortcut: [{ key: ["ArrowUp", "Up"], mod: true, alt: true, focus: "any" }],
    hint: () => `${shortcutAltMod()} ↑`,
  },
  {
    id: "open-command-palette",
    label: () => strings.palette.openPalette,
    scope: "global",
    shortcut: [
      { key: "k", mod: true, shift: false, alt: false, focus: "not-editing" },
    ],
    hint: () => `${shortcutMod()} K`,
    keywords: ["commands", "actions", "jump"],
  },
  {
    id: "undo",
    run: viaBus("undo"),
    available: hasUndoableMove,
    label: () => strings.notices.undoLastMove,
    scope: "global",
    shortcut: [
      { key: "z", mod: true, shift: false, alt: false, focus: "not-editing" },
    ],
    hint: () => `${shortcutMod()} Z`,
  },
  {
    id: "show-shortcuts",
    label: () => strings.settings.shortcutsTitle,
    scope: "global",
    shortcut: [{ key: "?", mod: false, alt: false, focus: "not-editing" }],
    hint: () => "?",
    run: viaBus("show-shortcuts"),
    keywords: ["help", "keys", "hotkeys"],
  },
];

const BY_ID = new Map<ActionId, ActionDefinition>(
  ACTIONS.map((action) => [action.id, action]),
);

export function listActions(): readonly ActionDefinition[] {
  return ACTIONS;
}

export function getAction(id: ActionId): ActionDefinition | undefined {
  return BY_ID.get(id);
}
