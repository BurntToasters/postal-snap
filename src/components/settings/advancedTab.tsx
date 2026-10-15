import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { DistributionChannel, UpdateChannel } from "../../types";
import { onUpdateChannelChanged } from "../../update";
import { SettingRow, SettingsPanel } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface AdvancedTabProps {
  setAdvertisingBlocking: (enabled: boolean) => Promise<void>;
  setThreatBlocking: (enabled: boolean) => Promise<void>;
  distribution?: DistributionChannel;
  update: SettingsSaveUpdate;
}

export function AdvancedTab({
  setAdvertisingBlocking,
  setThreatBlocking,
  distribution,
  update,
}: AdvancedTabProps) {
  const settings = useAppStore((state) => state.settings);
  const advertisingOn = settings.blockAdvertisingAndTracking;
  const threatsOn = settings.blockReportedThreats;

  return (
    <SettingsPanel id="advanced" title={strings.settings.advanced}>
      <div className="security-summary">
        <span>
          <strong>{strings.settings.vaultTitle}</strong>
          <small>{strings.settings.vaultHelp}</small>
        </span>
      </div>
      <p className="settings-lead">{strings.settings.advancedHelp}</p>
      <label className="switch-row">
        <span>
          <strong>{strings.settings.blockAds}</strong>
          <small>{strings.settings.blockAdsHelp}</small>
        </span>
        <input
          type="checkbox"
          checked={advertisingOn}
          onChange={(event) =>
            void setAdvertisingBlocking(event.target.checked)
          }
        />
      </label>
      <label className="switch-row">
        <span>
          <strong>{strings.settings.blockThreats}</strong>
          <small>{strings.settings.blockThreatsHelp}</small>
        </span>
        <input
          type="checkbox"
          checked={threatsOn}
          onChange={(event) => void setThreatBlocking(event.target.checked)}
        />
      </label>
      {distribution?.updatesManagedBy === "postalSnap" ? (
        <SettingRow
          title={strings.settings.updateChannel}
          help={strings.settings.updateChannelHelp}
        >
          <select
            aria-label={strings.settings.updateChannel}
            value={settings.updateChannel}
            onChange={async (event) => {
              const before = useAppStore.getState().settings.updateChannel;
              await update({
                updateChannel: event.target.value as UpdateChannel,
              });
              // A failed save rolls back; keep the downloaded update then.
              if (useAppStore.getState().settings.updateChannel !== before) {
                onUpdateChannelChanged();
              }
            }}
          >
            <option value="auto">{strings.settings.updateChannelAuto}</option>
            <option value="stable">
              {strings.settings.updateChannelStable}
            </option>
            <option value="beta">{strings.settings.updateChannelBeta}</option>
          </select>
        </SettingRow>
      ) : null}
      {threatsOn ? null : (
        <div className="settings-warning" role="status">
          {strings.settings.threatOffWarning}
        </div>
      )}
    </SettingsPanel>
  );
}
