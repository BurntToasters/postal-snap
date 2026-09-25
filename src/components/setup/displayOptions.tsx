import { strings } from "../../i18n";
import { useSettingsSave } from "../settings/useSettingsSave";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";

type DisplayPatch = Partial<
  Pick<AppSettings, "theme" | "density" | "textScale" | "readingPane">
>;

interface Props {
  onChange: (patch: DisplayPatch) => void;
}

// Theme, spacing, text size, and reading pane, shared by both setup paths.
export function DisplayOptions({ onChange }: Props) {
  const settings = useAppStore((state) => state.settings);

  return (
    <div className="setup-field-grid">
      <label>
        {strings.settings.appearance}
        <select
          aria-label={strings.settings.appearance}
          value={settings.theme}
          onChange={(event) =>
            onChange({ theme: event.target.value as AppSettings["theme"] })
          }
        >
          <option value="system">{strings.settings.autoDefault}</option>
          <option value="light">{strings.settings.light}</option>
          <option value="dark">{strings.settings.dark}</option>
        </select>
        <small>{strings.settings.appearanceHelp}</small>
      </label>
      <label>
        {strings.settings.spacing}
        <select
          aria-label={strings.settings.spacing}
          value={settings.density}
          onChange={(event) =>
            onChange({
              density: event.target.value as AppSettings["density"],
            })
          }
        >
          <option value="comfortable">{strings.settings.comfortable}</option>
          <option value="compact">{strings.settings.compact}</option>
        </select>
        <small>{strings.settings.spacingHelp}</small>
      </label>
      <label>
        {strings.settings.textSize}
        <select
          aria-label={strings.settings.textSize}
          value={settings.textScale}
          onChange={(event) =>
            onChange({ textScale: Number(event.target.value) })
          }
        >
          <option value={0.85}>{strings.settings.small}</option>
          <option value={1}>{strings.settings.normal}</option>
          <option value={1.15}>{strings.settings.large}</option>
          <option value={1.3}>{strings.settings.extraLarge}</option>
          <option value={1.5}>{strings.settings.veryLarge}</option>
          <option value={2}>{strings.settings.largest}</option>
        </select>
        <small>{strings.settings.textSizeHelp}</small>
      </label>
      <label>
        {strings.settings.readingPane}
        <select
          aria-label={strings.settings.readingPane}
          value={settings.readingPane}
          onChange={(event) =>
            onChange({
              readingPane: event.target.value as AppSettings["readingPane"],
            })
          }
        >
          <option value="right">{strings.settings.paneRight}</option>
          <option value="bottom">{strings.settings.paneBottom}</option>
          <option value="hidden">{strings.settings.paneHidden}</option>
        </select>
        <small>{strings.settings.readingPaneHelp}</small>
      </label>
    </div>
  );
}

// Standalone setup only. Owning the save queue here means embedded setup
// (inside SetupFlow) never creates a second settings writer.
export function SetupDisplaySection() {
  const { update } = useSettingsSave();
  return (
    <section className="setup-display" aria-labelledby="setup-display-title">
      <h2 id="setup-display-title">{strings.setup.displayTitle}</h2>
      <p className="setup-field-hint">{strings.setup.displayHint}</p>
      <DisplayOptions onChange={(patch) => void update(patch)} />
    </section>
  );
}
