import { DownloadCloud } from "lucide-react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { DistributionChannel, UpdateCheckInterval } from "../../types";
import { applyPendingUpdate } from "../../update";
import { editionName } from "./helpers";
import { SettingRow, SettingsPanel } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface UpdatesTabProps {
  distribution?: DistributionChannel;
  updateStatus: string;
  checkingUpdate: boolean;
  checkForUpdates: () => Promise<void>;
  update: SettingsSaveUpdate;
}

export function UpdatesTab({
  distribution,
  updateStatus,
  checkingUpdate,
  checkForUpdates,
  update,
}: UpdatesTabProps) {
  const settings = useAppStore((state) => state.settings);
  const updateReady = useAppStore((state) => state.updateReady);
  const postalSnapUpdates = distribution?.updatesManagedBy === "postalSnap";

  return (
    <SettingsPanel id="updates" title={strings.settings.updates}>
      {updateReady ? (
        <div className="update-ready-card">
          <div className="update-ready-icon">
            <DownloadCloud aria-hidden="true" />
          </div>
          <div className="update-ready-body">
            <strong>{strings.settings.updateReadyCardTitle}</strong>
            <p>{strings.settings.updateReadyCardHelp(updateReady)}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => void applyPendingUpdate()}
            >
              {strings.settings.restartNow}
            </button>
          </div>
        </div>
      ) : null}
      <div className="storage-card">
        <DownloadCloud aria-hidden="true" />
        <span>
          <strong>
            {distribution?.updatesManagedBy === "store"
              ? strings.settings.storeUpdateTitle
              : distribution?.updatesManagedBy === "githubDownload"
                ? strings.settings.githubUpdateTitle
                : strings.settings.directUpdateTitle}
          </strong>
          <small>
            {distribution
              ? editionName(distribution.kind)
              : strings.settings.checkingEdition}
          </small>
        </span>
      </div>
      {postalSnapUpdates ? (
        <>
          <SettingRow
            title={strings.settings.updateCheckInterval}
            help={strings.settings.updateCheckIntervalHelp}
          >
            <select
              aria-label={strings.settings.updateCheckInterval}
              value={settings.updateCheckInterval}
              onChange={(event) =>
                void update({
                  updateCheckInterval: event.target
                    .value as UpdateCheckInterval,
                })
              }
            >
              <option value="startupAnd6h">
                {strings.settings.updateCheckStartupAnd6h}
              </option>
              <option value="startupAnd12h">
                {strings.settings.updateCheckStartupAnd12h}
              </option>
              <option value="startupAnd24h">
                {strings.settings.updateCheckStartupAnd24h}
              </option>
              <option value="startup">
                {strings.settings.updateCheckStartup}
              </option>
              <option value="manual">
                {strings.settings.updateCheckManual}
              </option>
            </select>
          </SettingRow>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void checkForUpdates()}
            disabled={checkingUpdate}
          >
            {updateStatus}
          </button>
        </>
      ) : null}
    </SettingsPanel>
  );
}
