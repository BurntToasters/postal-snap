import { useEffect, useState } from "react";
import { api } from "../../api";
import { formatBytes } from "../../format";
import { strings } from "../../i18n";
import type { CachePolicy, CacheUsage } from "../../types";
import { SettingRow, SettingsGroup } from "./primitives";

const recentPolicy: CachePolicy = {
  mode: "recent",
  days: 90,
  maxBytes: 1_073_741_824,
};

export function AccountDownloadPanel({ accountId }: { accountId: string }) {
  const [policy, setPolicy] = useState<CachePolicy>();
  const [usage, setUsage] = useState<CacheUsage>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      api.getAccountCachePolicy(accountId),
      api.getAccountCacheUsage(accountId),
    ])
      .then(([nextPolicy, nextUsage]) => {
        if (!disposed) {
          setPolicy(nextPolicy);
          setUsage(nextUsage);
        }
      })
      .catch(() => {
        if (!disposed) setError(strings.settings.accountDownloadFailed);
      });
    return () => {
      disposed = true;
    };
  }, [accountId]);

  async function save(next: CachePolicy) {
    setBusy(true);
    setStatus("");
    setError("");
    try {
      const saved = await api.setAccountCachePolicy(accountId, next);
      setPolicy(saved);
      setUsage(await api.getAccountCacheUsage(accountId));
      setStatus(strings.settings.accountDownloadSaved);
    } catch {
      setError(strings.settings.accountDownloadFailed);
    } finally {
      setBusy(false);
    }
  }

  async function clearDownloads() {
    const confirmed = await api.showNativeConfirm(
      strings.settings.clearAccountMail,
      strings.settings.clearMailQuestion,
    );
    if (!confirmed) return;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      await api.clearAccountDownloads(accountId);
      setUsage(await api.getAccountCacheUsage(accountId));
      setStatus(strings.settings.accountDownloadSaved);
    } catch {
      setError(strings.settings.accountDownloadFailed);
    } finally {
      setBusy(false);
    }
  }

  if (!policy) {
    return error ? <p role="alert">{error}</p> : null;
  }

  return (
    <div className="settings-section">
      <h3>{strings.settings.accountDownload}</h3>
      <p className="settings-note">{strings.settings.accountDownloadHelp}</p>
      <p>
        {usage
          ? `${formatBytes(usage.bytes)} ${strings.settings.used}`
          : strings.settings.calculating}
      </p>
      <SettingsGroup>
        <SettingRow
          title={strings.settings.cacheMode}
          help={strings.settings.accountDownloadHelp}
        >
          <select
            aria-label={strings.settings.cacheMode}
            disabled={busy}
            value={policy.mode}
            onChange={(event) => {
              const mode = event.target.value;
              void save(
                mode === "full"
                  ? { mode: "full", days: 0, maxBytes: 0 }
                  : recentPolicy,
              );
            }}
          >
            <option value="recent">{strings.settings.cacheRecent}</option>
            <option value="full">{strings.settings.cacheFull}</option>
          </select>
        </SettingRow>
        {policy.mode === "recent" ? (
          <SettingRow
            title={strings.settings.cacheDays}
            help={strings.settings.accountDownloadHelp}
          >
            <select
              aria-label={strings.settings.cacheDays}
              disabled={busy}
              value={policy.days}
              onChange={(event) =>
                void save({ ...policy, days: Number(event.target.value) })
              }
            >
              <option value={30}>{strings.settings.cacheDaysOption(30)}</option>
              <option value={90}>{strings.settings.cacheDaysOption(90)}</option>
              <option value={180}>
                {strings.settings.cacheDaysOption(180)}
              </option>
              <option value={365}>
                {strings.settings.cacheDaysOption(365)}
              </option>
            </select>
          </SettingRow>
        ) : null}
        <SettingRow
          title={strings.settings.cacheLimit}
          help={strings.settings.accountDownloadHelp}
        >
          <select
            aria-label={strings.settings.cacheLimit}
            disabled={busy || policy.mode === "full"}
            value={policy.maxBytes}
            onChange={(event) =>
              void save({ ...policy, maxBytes: Number(event.target.value) })
            }
          >
            {policy.mode === "full" ? (
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
      </SettingsGroup>
      <button
        className="secondary-button"
        type="button"
        disabled={busy}
        onClick={() => void clearDownloads()}
      >
        {strings.settings.clearAccountMail}
      </button>
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
