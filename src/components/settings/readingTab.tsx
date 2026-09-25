import { strings } from "../../i18n";
import { READING_PANE_CHOICES, TEXT_SCALE_CHOICES } from "./displayChoices";
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
          {READING_PANE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
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
          {TEXT_SCALE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
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
