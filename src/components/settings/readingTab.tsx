import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingRow, SettingsPanel } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface ReadingTabProps {
  update: SettingsSaveUpdate;
}

export function ReadingTab({ update }: ReadingTabProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <SettingsPanel id="reading" title={strings.settings.reading}>
      <label className="switch-row">
        <span>
          <strong>{strings.settings.groupThreads}</strong>
          <small>{strings.settings.groupThreadsHelp}</small>
        </span>
        <input
          type="checkbox"
          checked={settings.groupThreads}
          onChange={(event) =>
            void update({ groupThreads: event.target.checked })
          }
        />
      </label>
      <SettingRow
        title={strings.mail.undoSendWindow}
        help={strings.mail.undoSendHelp}
      >
        <select
          aria-label={strings.mail.undoSendWindow}
          value={settings.undoSendSeconds ?? 10}
          onChange={(event) =>
            void update({ undoSendSeconds: Number(event.target.value) })
          }
        >
          <option value={0}>{strings.mail.undoSendOff}</option>
          {[5, 10, 20, 30].map((seconds) => (
            <option key={seconds} value={seconds}>
              {strings.mail.undoSendSeconds(seconds)}
            </option>
          ))}
        </select>
      </SettingRow>
    </SettingsPanel>
  );
}
