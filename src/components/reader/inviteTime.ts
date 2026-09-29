import { strings } from "../../i18n";
import type { IcsTime } from "../../types";

/** Instant for wall-clock time `iso` in IANA zone `tz`; undefined if unknown. */
function zonedInstant(iso: string, tz: string): Date | undefined {
  try {
    const wall = Date.parse(`${iso}Z`);
    if (Number.isNaN(wall)) return undefined;
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const offsetAt = (instant: number) => {
      const parts = Object.fromEntries(
        format
          .formatToParts(new Date(instant))
          .map((part) => [part.type, Number(part.value)]),
      );
      const asUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      );
      return asUtc - Math.floor(instant / 1000) * 1000;
    };
    const first = wall - offsetAt(wall);
    return new Date(wall - offsetAt(first));
  } catch {
    return undefined;
  }
}

function dateOnly(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

interface Resolved {
  date: Date;
  /** Wall clock in a zone this device cannot convert: show as written. */
  zoneLabel?: string;
}

function resolve(time: IcsTime): Resolved | undefined {
  if (time.allDay) return { date: dateOnly(time.iso) };
  if (time.utc) return { date: new Date(time.iso) };
  if (time.tzid) {
    const instant = zonedInstant(time.iso, time.tzid);
    if (instant) return { date: instant };
    return { date: new Date(`${time.iso}Z`), zoneLabel: time.tzid };
  }
  return { date: new Date(time.iso) };
}

/** Localized "when" text for an invite. */
export function formatInviteRange(
  start?: IcsTime | null,
  end?: IcsTime | null,
): string {
  const from = start ? resolve(start) : undefined;
  if (!start || !from || Number.isNaN(from.date.getTime())) return "";
  const to = end ? resolve(end) : undefined;
  const validTo = to && !Number.isNaN(to.date.getTime()) ? to : undefined;
  if (start.allDay) {
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });
    // An all-day end date is exclusive.
    const last = validTo
      ? new Date(validTo.date.getTime() - 24 * 60 * 60 * 1000)
      : undefined;
    const text =
      last && last.getTime() > from.date.getTime()
        ? `${day.format(from.date)} – ${day.format(last)}`
        : day.format(from.date);
    return `${text} (${strings.reader.inviteAllDay})`;
  }
  const zone = from.zoneLabel;
  const zoneOption: Intl.DateTimeFormatOptions = zone
    ? { timeZone: "UTC" }
    : {};
  const full = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption,
  });
  const timeOnly = new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
    ...zoneOption,
  });
  const dayKey = (date: Date) =>
    zone
      ? date.toISOString().slice(0, 10)
      : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const suffix = zone ? ` (${zone})` : "";
  if (!validTo) return `${full.format(from.date)}${suffix}`;
  return dayKey(from.date) === dayKey(validTo.date)
    ? `${full.format(from.date)} – ${timeOnly.format(validTo.date)}${suffix}`
    : `${full.format(from.date)} – ${full.format(validTo.date)}${suffix}`;
}
