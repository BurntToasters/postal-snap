import { strings } from "./i18n";

export function formatMessageDate(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return strings.mail.yesterday;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  ).format(date);
}

export function shortcutMod(): string {
  return document.documentElement.dataset.platform === "macos" ? "⌘" : "Ctrl";
}

export function shortcutShiftMod(): string {
  return document.documentElement.dataset.platform === "macos"
    ? "⇧⌘"
    : "Ctrl+Shift";
}
