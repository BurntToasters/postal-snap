import { useEffect, useState } from "react";

import { api } from "../../api";
import { strings } from "../../i18n";
import { applySettings } from "../../settings";
import { useAppStore } from "../../store";
import type { CacheUsage } from "../../types";

/** Storage usage, settings import/export, cache cleanup, and data erasure. */
export function useSettingsStorage() {
  const setError = useAppStore((state) => state.setError);
  const setSettings = useAppStore((state) => state.setSettings);
  const [usage, setUsage] = useState<CacheUsage>();
  const [dataBusy, setDataBusy] = useState(false);
  const [dataStatus, setDataStatus] = useState<string>();
  const [eraseBusy, setEraseBusy] = useState(false);
  const [eraseStatus, setEraseStatus] = useState<string>();

  useEffect(() => {
    let active = true;
    void api
      .cacheUsage()
      .then((result) => {
        if (active) setUsage(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function clearCache() {
    const confirmed = await api.showNativeConfirm(
      strings.settings.clearMail,
      strings.settings.clearMailQuestion,
    );
    if (!confirmed) return;
    try {
      await api.clearCache();
      setUsage(await api.cacheUsage());
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function retryAttachmentCleanup() {
    try {
      const leftovers = await api.retryAttachmentCleanup();
      setUsage((current) =>
        current ? { ...current, attachmentLeftovers: leftovers } : current,
      );
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function exportSettings() {
    if (dataBusy) return;
    setDataBusy(true);
    setDataStatus(undefined);
    try {
      if (await api.exportSettings())
        setDataStatus(strings.settings.exportSaved);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDataBusy(false);
    }
  }

  async function importSettings() {
    if (dataBusy) return;
    const confirmed = await api.showNativeConfirm(
      strings.settings.importSettings,
      strings.settings.importQuestion,
    );
    if (!confirmed) return;
    setDataBusy(true);
    setDataStatus(undefined);
    try {
      const imported = await api.importSettings();
      if (imported) {
        setSettings(imported);
        applySettings(imported);
        setDataStatus(strings.settings.importApplied);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDataBusy(false);
    }
  }

  async function eraseAllData() {
    if (eraseBusy) return;
    const confirmed = await api.showNativeConfirm(
      strings.settings.eraseTitle,
      strings.settings.eraseQuestion,
    );
    if (!confirmed) return;
    setEraseBusy(true);
    setEraseStatus(undefined);
    try {
      await api.eraseAllData();
      await api.relaunch();
    } catch (cause) {
      setEraseStatus(strings.settings.eraseFailed);
      setError(String(cause));
    } finally {
      setEraseBusy(false);
    }
  }

  return {
    usage,
    dataBusy,
    dataStatus,
    eraseBusy,
    eraseStatus,
    clearCache,
    retryAttachmentCleanup,
    exportSettings,
    importSettings,
    eraseAllData,
  };
}
