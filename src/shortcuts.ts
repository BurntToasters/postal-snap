import { shortcutAltMod, shortcutMod, shortcutShiftMod } from "./format";
import { strings } from "./i18n";

export interface ShortcutItem {
  id: string;
  label: string;
  keys: string;
}

export function getShortcutsRegistry(): ShortcutItem[] {
  const mod = shortcutMod();
  const shiftMod = shortcutShiftMod();
  const altMod = shortcutAltMod();

  return [
    { id: "new-message", label: strings.composer.newMessage, keys: `${mod} N` },
    { id: "get-mail", label: strings.mail.getMail, keys: `${shiftMod} N` },
    { id: "reply", label: strings.reader.reply, keys: `${mod} R` },
    { id: "reply-all", label: strings.reader.replyAll, keys: `${shiftMod} R` },
    { id: "forward", label: strings.reader.forward, keys: `${shiftMod} F` },
    { id: "archive", label: strings.reader.archive, keys: `${mod} E` },
    { id: "trash", label: strings.reader.trash, keys: `${mod} ⌫` },
    { id: "search", label: strings.mail.search, keys: `${mod} F / /` },
    {
      id: "find-in-message",
      label: strings.reader.findInMessage,
      keys: `${altMod} F`,
    },
    { id: "send", label: strings.composer.send, keys: `${mod} ↵` },
    { id: "save-draft", label: strings.composer.saveDraft, keys: `${mod} S` },
    {
      id: "text-size",
      label: strings.settings.textSize,
      keys: `${mod} + / ${mod} -`,
    },
    { id: "settings", label: strings.mail.settings, keys: `${mod} ,` },
    {
      id: "next-message",
      label: strings.settings.shortcutNextMessage,
      keys: "j / ↓",
    },
    {
      id: "prev-message",
      label: strings.settings.shortcutPreviousMessage,
      keys: "k / ↑",
    },
    {
      id: "first-last",
      label: strings.settings.shortcutFirstLastMessage,
      keys: "Home / End",
    },
    {
      id: "scroll-reader",
      label: strings.settings.shortcutScrollReader,
      keys: "Space / ⇧ Space",
    },
    { id: "delete-msg", label: strings.reader.trash, keys: "Delete" },
    {
      id: "toggle-read",
      label: strings.settings.shortcutMarkReadUnread,
      keys: `${shiftMod} U`,
    },
    {
      id: "toggle-star",
      label: strings.settings.shortcutStarMessage,
      keys: `${shiftMod} L`,
    },
    { id: "print", label: strings.reader.print, keys: `${mod} P` },
  ];
}
