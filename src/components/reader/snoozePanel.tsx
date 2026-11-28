import { useEffect, useRef, useState } from "react";
import { strings } from "../../i18n";
import { laterTodayIso } from "./snoozeTimes";

export function SnoozePanel({
  onSnooze,
  onClose,
  label = strings.reader.snooze,
}: {
  onSnooze: (untilIso: string) => void;
  onClose: () => void;
  label?: string;
}) {
  const [custom, setCustom] = useState("");
  // Escape closes from either call site; each onClose restores focus to its
  // invoking trigger. The ref keeps the listener stable across renders.
  const panelRef = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (panelRef.current?.closest("[inert]")) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  function atMorning(date: Date): string {
    date.setHours(8, 0, 0, 0);
    return date.toISOString();
  }
  function tomorrowMorning(): string {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return atMorning(date);
  }
  function nextMonday(): string {
    const date = new Date();
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
    return atMorning(date);
  }
  const laterToday = laterTodayIso();
  const nowLocalMin = (() => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60_000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 16);
  })();
  return (
    <form
      ref={panelRef}
      noValidate
      className="snooze-panel"
      role="group"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        if (!custom) return;
        const parsed = new Date(custom);
        if (Number.isFinite(parsed.getTime())) onSnooze(parsed.toISOString());
      }}
    >
      {laterToday ? (
        <button type="button" onClick={() => onSnooze(laterToday)}>
          {strings.reader.snoozeLaterToday}
        </button>
      ) : null}
      <button
        type="button"
        autoFocus
        onClick={() => onSnooze(tomorrowMorning())}
      >
        {strings.reader.snoozeTomorrow}
      </button>
      <button type="button" onClick={() => onSnooze(nextMonday())}>
        {strings.reader.snoozeNextWeek}
      </button>
      <label>
        <span className="visually-hidden">{strings.reader.snoozeCustom}</span>
        <input
          type="datetime-local"
          min={nowLocalMin}
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
        />
      </label>
      <button type="submit" disabled={!custom}>
        {strings.reader.snoozeUntil}
      </button>
      <button type="button" className="toolbar-button" onClick={onClose}>
        {strings.common.cancel}
      </button>
    </form>
  );
}
