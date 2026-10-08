import { DownloadCloud, Upload } from "lucide-react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { CloseToTraySwitch } from "./closeToTray";
import { SettingsPanel, SettingsSection } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";
import type { SettingsTab } from "./primitives";

interface GeneralTabProps {
  update: SettingsSaveUpdate;
  windowFxSupported: boolean;
  dataBusy: boolean;
  dataStatus?: string;
  setTab: (tab: SettingsTab) => void;
  exportSettings: () => Promise<void>;
  importSettings: () => Promise<void>;
}

export function GeneralTab({
  update,
  dataBusy,
  dataStatus,
  exportSettings,
  importSettings,
}: GeneralTabProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <SettingsPanel id="general" title={strings.settings.general}>
      <CloseToTraySwitch
        checked={settings.closeToTray}
        onChecked={(checked) => void update({ closeToTray: checked })}
      />
      <SettingsSection title={strings.settings.settingsData}>
        <div className="settings-data-card">
          <div>
            <small>{strings.settings.settingsDataHelp}</small>
          </div>
          <div className="settings-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void exportSettings()}
              disabled={dataBusy}
            >
              <Upload aria-hidden="true" /> {strings.settings.exportSettings}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void importSettings()}
              disabled={dataBusy}
            >
              <DownloadCloud aria-hidden="true" />{" "}
              {strings.settings.importSettings}
            </button>
          </div>
          {dataStatus ? (
            <small className="settings-data-status" role="status">
              {dataStatus}
            </small>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPanel>
  );
}
