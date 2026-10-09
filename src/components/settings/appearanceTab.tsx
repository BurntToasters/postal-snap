import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";
import {
  DENSITY_CHOICES,
  THEME_CHOICES,
  READING_PANE_CHOICES,
  TEXT_SCALE_CHOICES,
} from "./displayChoices";
import { SettingRow, SettingsPanel, SettingsSection } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

export function AppearanceTab({
  update,
  windowFxSupported,
}: {
  update: SettingsSaveUpdate;
  windowFxSupported: boolean;
}) {
  const settings = useAppStore((state) => state.settings);
  return (
    <SettingsPanel id="appearance" title={strings.settings.appearanceTitle}>
      <SettingsSection title={strings.settings.appearanceTitle}>
        <SettingRow
          title={strings.settings.appearance}
          help={strings.settings.appearanceHelp}
        >
          <select
            aria-label={strings.settings.appearance}
            value={settings.theme}
            onChange={(event) =>
              void update({ theme: event.target.value as AppSettings["theme"] })
            }
          >
            {THEME_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          title={strings.settings.spacing}
          help={strings.settings.spacingHelp}
        >
          <select
            aria-label={strings.settings.spacing}
            value={settings.density}
            onChange={(event) =>
              void update({
                density: event.target.value as AppSettings["density"],
              })
            }
          >
            {DENSITY_CHOICES.map((choice) => (
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
      </SettingsSection>
      <SettingsSection title={strings.settings.readingPane}>
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
        <label className="switch-row">
          <span>
            <strong>{strings.settings.sidebar}</strong>
            <small>{strings.settings.sidebarHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.sidebarVisible !== false}
            onChange={(event) =>
              void update({ sidebarVisible: event.target.checked })
            }
          />
        </label>
        {windowFxSupported ? (
          <label className="switch-row">
            <span>
              <strong>{strings.settings.windowEffects}</strong>
              <small>{strings.settings.windowEffectsHelp}</small>
            </span>
            <input
              type="checkbox"
              checked={settings.windowEffects}
              onChange={(event) =>
                void update({ windowEffects: event.target.checked })
              }
            />
          </label>
        ) : null}
      </SettingsSection>
    </SettingsPanel>
  );
}
