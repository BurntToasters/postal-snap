import { useState } from "react";
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
  return (
    <div className="snooze-panel" role="group" aria-label={label}>
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
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!custom}
        onClick={() => {
          const parsed = new Date(custom);
          if (Number.isFinite(parsed.getTime())) onSnooze(parsed.toISOString());
        }}
      >
        {strings.reader.snoozeUntil}
      </button>
      <button type="button" className="toolbar-button" onClick={onClose}>
        {strings.common.cancel}
      </button>
    </div>
  );
}
