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
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays >= 0 && diffDays < 6) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
    }).format(date);
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

export function shortcutAltMod(): string {
  return document.documentElement.dataset.platform === "macos"
    ? "⌥⌘"
    : "Ctrl+Alt";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatFullMessageDate(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const fullDate = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);

  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  let relative = "";
  if (diffMs >= 0) {
    if (diffMinutes < 1) relative = strings.mail.justNow;
    else if (diffMinutes < 60) relative = strings.mail.minutesAgo(diffMinutes);
    else if (diffHours < 24) relative = strings.mail.hoursAgo(diffHours);
    else if (diffDays === 1) relative = strings.mail.yesterday.toLowerCase();
    else if (diffDays < 30) relative = strings.mail.daysAgo(diffDays);
  }

  return relative ? `${fullDate} (${relative})` : fullDate;
}

/** When a scheduled message sends: a time today, else a day and time. */
export function formatScheduledTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  return `${day}, ${time}`;
}
