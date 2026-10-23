import { strings } from "./i18n";

/** Formatters for one list-render batch. Construct once, reuse per row. */
export interface ListDateFormatters {
  time: Intl.DateTimeFormat;
  weekdayShort: Intl.DateTimeFormat;
  weekdayLong: Intl.DateTimeFormat;
  sameYearShort: Intl.DateTimeFormat;
  otherYearShort: Intl.DateTimeFormat;
  sameYearLong: Intl.DateTimeFormat;
  otherYearLong: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
}

export function createListDateFormatters(
  locale?: Intl.LocalesArgument,
): ListDateFormatters {
  return {
    time: new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }),
    weekdayShort: new Intl.DateTimeFormat(locale, { weekday: "short" }),
    weekdayLong: new Intl.DateTimeFormat(locale, { weekday: "long" }),
    sameYearShort: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
    }),
    otherYearShort: new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
    sameYearLong: new Intl.DateTimeFormat(locale, {
      month: "long",
      day: "numeric",
    }),
    otherYearLong: new Intl.DateTimeFormat(locale, {
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    full: new Intl.DateTimeFormat(locale, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }),
  };
}

export function formatMessageDate(
  value: string,
  now = new Date(),
  formatters?: ListDateFormatters,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (date.toDateString() === now.toDateString()) {
    return (
      formatters?.time ??
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })
    ).format(date);
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
    return (
      formatters?.weekdayShort ??
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
      })
    ).format(date);
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  if (sameYear) {
    return (
      formatters?.sameYearShort ??
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
    ).format(date);
  }
  return (
    formatters?.otherYearShort ??
    new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  ).format(date);
}

/** List row date, with the clock time when the label is not already a time. */
export function formatMessageListWhen(
  value: string,
  now = new Date(),
  formatters?: ListDateFormatters,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const label = formatMessageDate(value, now, formatters);
  if (date.toDateString() === now.toDateString()) return label;
  const time = (
    formatters?.time ??
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })
  ).format(date);
  return `${label}, ${time}`;
}

/** Calendar-day label for a date-ordered message list. */
export function messageListDay(
  value: string,
  now = new Date(),
  formatters?: ListDateFormatters,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === now.toDateString()) return strings.mail.today;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return strings.mail.yesterday;
  const dayIndex = (item: Date) =>
    Date.UTC(item.getFullYear(), item.getMonth(), item.getDate());
  const diffDays = Math.round(
    (dayIndex(now) - dayIndex(date)) / (24 * 60 * 60 * 1000),
  );
  if (diffDays > 1 && diffDays < 7) {
    return (
      formatters?.weekdayLong ??
      new Intl.DateTimeFormat(undefined, { weekday: "long" })
    ).format(date);
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  if (sameYear) {
    return (
      formatters?.sameYearLong ??
      new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" })
    ).format(date);
  }
  return (
    formatters?.otherYearLong ??
    new Intl.DateTimeFormat(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
  ).format(date);
}

/** Consecutive rows that share a day label stay under one heading. */
export function groupByDayLabel<T>(
  items: readonly T[],
  labelOf: (item: T) => string,
): Array<{ label: string; items: T[] }> {
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const label = labelOf(item);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
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

/** Platform-aware chord: ⌘R on macOS, Ctrl+R elsewhere. */
export function shortcutChord(
  key: string,
  options?: { shift?: boolean; alt?: boolean },
): string {
  const isMac = document.documentElement.dataset.platform === "macos";
  if (isMac) {
    const shift = options?.shift ? "⇧" : "";
    const alt = options?.alt ? "⌥" : "";
    return `${shift}${alt}⌘${key}`;
  }
  const parts = ["Ctrl"];
  if (options?.alt) parts.push("Alt");
  if (options?.shift) parts.push("Shift");
  return `${parts.join("+")}+${key}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatFullMessageDate(
  value: string,
  now = new Date(),
  formatters?: ListDateFormatters,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const fullDate = (
    formatters?.full ??
    new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    })
  ).format(date);

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

/** Server arrival time when it is at least 15 minutes from the Date header. */
export function notableArrival(
  receivedAt: string,
  arrivedAt?: string | null,
): string | undefined {
  if (!arrivedAt) return undefined;
  const received = Date.parse(receivedAt);
  const arrived = Date.parse(arrivedAt);
  if (!Number.isFinite(received) || !Number.isFinite(arrived)) return undefined;
  if (Math.abs(arrived - received) < 15 * 60 * 1000) return undefined;
  return arrivedAt;
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
