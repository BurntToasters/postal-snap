import { DownloadCloud } from "lucide-react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { DistributionChannel } from "../../types";
import { SettingsPanel, editionName } from "./primitives";

interface UpdatesTabProps {
  distribution?: DistributionChannel;
  updateStatus: string;
  checkingUpdate: boolean;
  checkForUpdates: () => Promise<void>;
}

export function UpdatesTab({
  distribution,
  updateStatus,
  checkingUpdate,
  checkForUpdates,
}: UpdatesTabProps) {
  const updateReady = useAppStore((state) => state.updateReady);

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
              onClick={() => void api.relaunch()}
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
              : strings.settings.directUpdateTitle}
          </strong>
          <small>
            {distribution
              ? editionName(distribution.kind)
              : strings.settings.checkingEdition}
          </small>
        </span>
      </div>
      {distribution?.updatesManagedBy === "postalSnap" ? (
        <button
          className="secondary-button"
          type="button"
          onClick={() => void checkForUpdates()}
          disabled={checkingUpdate}
        >
          {updateStatus}
        </button>
      ) : null}
    </SettingsPanel>
  );
}
