import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";
import { SettingRow, SettingsPanel } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface ReadingTabProps {
  update: SettingsSaveUpdate;
}

export function ReadingTab({ update }: ReadingTabProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <SettingsPanel id="reading" title={strings.settings.reading}>
      <SettingRow
        title={strings.settings.readingPane}
        help={strings.settings.readingPaneHelp}
      >
        <select
          aria-label={strings.settings.readingPane}
          value={settings.readingPane}
          onChange={(event) =>
            void update({
              readingPane: event.target.value as AppSettings["readingPane"],
            })
          }
        >
          <option value="right">{strings.settings.paneRight}</option>
          <option value="bottom">{strings.settings.paneBottom}</option>
          <option value="hidden">{strings.settings.paneHidden}</option>
        </select>
      </SettingRow>
      <SettingRow
        title={strings.settings.textSize}
        help={strings.settings.textSizeHelp}
      >
        <select
          aria-label={strings.settings.textSize}
          value={settings.textScale}
          onChange={(event) =>
            void update({ textScale: Number(event.target.value) })
          }
        >
          <option value={0.85}>{strings.settings.small}</option>
          <option value={1}>{strings.settings.normal}</option>
          <option value={1.15}>{strings.settings.large}</option>
          <option value={1.3}>{strings.settings.extraLarge}</option>
          <option value={1.5}>{strings.settings.veryLarge}</option>
          <option value={2}>{strings.settings.largest}</option>
        </select>
      </SettingRow>
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
    </SettingsPanel>
  );
}
