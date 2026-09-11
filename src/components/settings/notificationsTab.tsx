import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingsPanel } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface NotificationsTabProps {
  update: SettingsSaveUpdate;
}

export function NotificationsTab({ update }: NotificationsTabProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <SettingsPanel id="notifications" title={strings.settings.notifications}>
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
    </SettingsPanel>
  );
}
