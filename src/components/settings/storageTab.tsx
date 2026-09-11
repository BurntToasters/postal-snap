import { Database } from "lucide-react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { CacheUsage } from "../../types";
import { SettingRow, SettingsPanel, formatBytes } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface StorageTabProps {
  usage?: CacheUsage;
  update: SettingsSaveUpdate;
  clearCache: () => Promise<void>;
}

export function StorageTab({ usage, update, clearCache }: StorageTabProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <SettingsPanel id="storage" title={strings.settings.storage}>
      <div className="storage-card">
        <Database />
        <span>
          <strong>
            {usage ? formatBytes(usage.bytes) : strings.settings.calculating}{" "}
            {strings.settings.used}
          </strong>
          <small>
            {settings.cachePolicy.mode === "full"
              ? strings.settings.storageSummaryFull(usage?.messageCount ?? 0)
              : strings.settings.storageSummary(
                  usage?.messageCount ?? 0,
                  settings.cachePolicy.days,
                  settings.cachePolicy.maxBytes === 0
                    ? strings.settings.cacheUnlimited
                    : formatBytes(settings.cachePolicy.maxBytes),
                )}
          </small>
        </span>
      </div>
      <SettingRow
        title={strings.settings.cacheMode}
        help={strings.settings.cachePolicyHelp}
      >
        <select
          aria-label={strings.settings.cacheMode}
          value={settings.cachePolicy.mode}
          onChange={(event) => {
            const mode = event.target.value as "recent" | "full";
            if (mode === "full") {
              void update({
                cachePolicy: {
                  mode: "full",
                  days: 0,
                  maxBytes: 0,
                },
              });
            } else {
              void update({
                cachePolicy: {
                  mode: "recent",
                  days: 90,
                  maxBytes: 1_073_741_824,
                },
              });
            }
          }}
        >
          <option value="recent">{strings.settings.cacheRecent}</option>
          <option value="full">{strings.settings.cacheFull}</option>
        </select>
      </SettingRow>
      {settings.cachePolicy.mode === "recent" ? (
        <SettingRow
          title={strings.settings.cacheDays}
          help={strings.settings.cachePolicyHelp}
        >
          <select
            aria-label={strings.settings.cacheDays}
            value={settings.cachePolicy.days}
            onChange={(event) =>
              void update({
                cachePolicy: { days: Number(event.target.value) },
              })
            }
          >
            <option value={30}>{strings.settings.cacheDaysOption(30)}</option>
            <option value={90}>{strings.settings.cacheDaysOption(90)}</option>
            <option value={180}>{strings.settings.cacheDaysOption(180)}</option>
            <option value={365}>{strings.settings.cacheDaysOption(365)}</option>
          </select>
        </SettingRow>
      ) : null}
      <SettingRow
        title={strings.settings.cacheLimit}
        help={strings.settings.cachePolicyHelp}
      >
        <select
          aria-label={strings.settings.cacheLimit}
          value={settings.cachePolicy.maxBytes}
          disabled={settings.cachePolicy.mode === "full"}
          onChange={(event) =>
            void update({
              cachePolicy: { maxBytes: Number(event.target.value) },
            })
          }
        >
          {settings.cachePolicy.mode === "full" ? (
            <option value={0}>{strings.settings.cacheUnlimited}</option>
          ) : (
            <>
              <option value={524_288_000}>500 MB</option>
              <option value={1_073_741_824}>1 GB</option>
              <option value={2_147_483_648}>2 GB</option>
              <option value={5_368_709_120}>5 GB</option>
              <option value={0}>{strings.settings.cacheUnlimited}</option>
            </>
          )}
        </select>
      </SettingRow>
      <button
        className="secondary-button"
        type="button"
        onClick={() => void clearCache()}
      >
        {strings.settings.clearMail}
      </button>
      <p className="settings-note">{strings.settings.clearMailHelp}</p>
    </SettingsPanel>
  );
}
