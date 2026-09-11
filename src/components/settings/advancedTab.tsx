import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingsPanel } from "./primitives";

interface AdvancedTabProps {
  setAdvertisingBlocking: (enabled: boolean) => Promise<void>;
  setThreatBlocking: (enabled: boolean) => Promise<void>;
}

export function AdvancedTab({
  setAdvertisingBlocking,
  setThreatBlocking,
}: AdvancedTabProps) {
  const settings = useAppStore((state) => state.settings);
  const advertisingOn = settings.blockAdvertisingAndTracking;
  const threatsOn = settings.blockReportedThreats;

  return (
    <SettingsPanel id="advanced" title={strings.settings.advanced}>
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
      {threatsOn ? null : (
        <div className="settings-warning" role="status">
          {strings.settings.threatOffWarning}
        </div>
      )}
    </SettingsPanel>
  );
}
