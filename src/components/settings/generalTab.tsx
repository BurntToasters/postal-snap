import { DownloadCloud, ShieldAlert, ShieldCheck, Upload } from "lucide-react";
import { strings } from "../../i18n";
import { DENSITY_CHOICES, THEME_CHOICES } from "./displayChoices";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";
import { CloseToTraySwitch } from "./closeToTray";
import { SettingRow, SettingsPanel, SettingsSection } from "./primitives";
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
  windowFxSupported,
  dataBusy,
  dataStatus,
  setTab,
  exportSettings,
  importSettings,
}: GeneralTabProps) {
  const settings = useAppStore((state) => state.settings);
  const advertisingOn = settings.blockAdvertisingAndTracking;
  const threatsOn = settings.blockReportedThreats;
  const protectionOn = advertisingOn && threatsOn;

  return (
    <SettingsPanel id="general" title={strings.settings.general}>
      <SettingsSection title={strings.settings.appearanceSection}>
        <SettingRow
          title={strings.settings.appearance}
          help={strings.settings.appearanceHelp}
        >
          <select
            aria-label={strings.settings.appearance}
            value={settings.theme}
            onChange={(event) =>
              void update({
                theme: event.target.value as AppSettings["theme"],
              })
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
        <CloseToTraySwitch
          checked={settings.closeToTray}
          onChecked={(checked) => void update({ closeToTray: checked })}
        />
      </SettingsSection>
      <SettingsSection title={strings.settings.sendingSection}>
        <SettingRow
          title={strings.mail.undoSendWindow}
          help={strings.mail.undoSendHelp}
        >
          <select
            aria-label={strings.mail.undoSendWindow}
            value={settings.undoSendSeconds ?? 10}
            onChange={(event) =>
              void update({
                undoSendSeconds: Number(event.target.value),
              })
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
      </SettingsSection>
      <SettingsSection title={strings.settings.privacySection}>
        <div className="security-summary">
          <ShieldCheck aria-hidden="true" />
          <span>
            <strong>{strings.settings.vaultTitle}</strong>
            <small>{strings.settings.vaultHelp}</small>
          </span>
        </div>
        <div
          className={
            protectionOn ? "security-summary" : "security-summary warning"
          }
        >
          {protectionOn ? (
            <ShieldCheck aria-hidden="true" />
          ) : (
            <ShieldAlert aria-hidden="true" />
          )}
          <span>
            <strong>
              {protectionOn
                ? strings.settings.protectionOn
                : strings.settings.protectionOff}
            </strong>
            <small>
              {protectionOn
                ? strings.settings.protectionOnHelp
                : threatsOn
                  ? strings.settings.protectionAdsOffHelp
                  : strings.settings.protectionOffHelp}
            </small>
          </span>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setTab("advanced");
              window.requestAnimationFrame(() => {
                document.getElementById("settings-tab-advanced")?.focus();
              });
            }}
          >
            {strings.settings.reviewAdvanced}
          </button>
        </div>
      </SettingsSection>
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
