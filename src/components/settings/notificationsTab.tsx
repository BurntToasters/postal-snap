import { useState } from "react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingsGroup, SettingsPanel } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface NotificationsTabProps {
  update: SettingsSaveUpdate;
}

export function NotificationsTab({ update }: NotificationsTabProps) {
  const settings = useAppStore((state) => state.settings);
  const [sameTimes, setSameTimes] = useState(false);

  function changeQuietHours(which: "start" | "end", value: string) {
    const start = which === "start" ? value : settings.quietHoursStart;
    const end = which === "end" ? value : settings.quietHoursEnd;
    if (start && end && start === end) {
      setSameTimes(true);
      return;
    }
    setSameTimes(false);
    void update({ quietHoursStart: start, quietHoursEnd: end });
  }

  return (
    <SettingsPanel id="notifications" title={strings.settings.notifications}>
      <SettingsGroup>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.notifyNewMail}</strong>
            <small>{strings.settings.notifyNewMailHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.notifyNewMail}
            onChange={(event) =>
              void update({ notifyNewMail: event.target.checked })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.newMailSound}</strong>
            <small>{strings.settings.newMailSoundHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.newMailSound}
            onChange={(event) =>
              void update({ newMailSound: event.target.checked })
            }
          />
        </label>
        <div className="switch-row">
          <span>
            <strong>{strings.settings.quietHours}</strong>
            <small>{strings.settings.quietHoursHelp}</small>
          </span>
          <span className="quiet-hours-times">
            <label>
              {strings.settings.quietHoursFrom}
              <input
                type="time"
                value={settings.quietHoursStart}
                onChange={(event) =>
                  changeQuietHours("start", event.target.value)
                }
              />
            </label>
            <label>
              {strings.settings.quietHoursUntil}
              <input
                type="time"
                value={settings.quietHoursEnd}
                onChange={(event) =>
                  changeQuietHours("end", event.target.value)
                }
              />
            </label>
          </span>
        </div>
        {sameTimes ? (
          <p className="settings-row-error" role="alert">
            {strings.settings.quietHoursSame}
          </p>
        ) : null}
        <label className="switch-row">
          <span>
            <strong>{strings.settings.privateNotifications}</strong>
            <small>{strings.settings.privateNotificationsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.privateNotifications}
            onChange={(event) =>
              void update({
                privateNotifications: event.target.checked,
              })
            }
          />
        </label>
      </SettingsGroup>
    </SettingsPanel>
  );
}
