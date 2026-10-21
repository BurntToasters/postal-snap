import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../api";
import { strings } from "../../i18n";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface Options {
  update: SettingsSaveUpdate;
}

/** Confirmation state and guarded controls for reported-threat protection. */
export function useSettingsThreatProtection({ update }: Options) {
  const [confirmThreatOff, setConfirmThreatOff] = useState(false);
  const [confirmToken, setConfirmToken] = useState("");
  const confirmInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!confirmThreatOff) return;
    const timer = window.setTimeout(() => confirmInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [confirmThreatOff]);

  const cancelThreatOff = useCallback(() => {
    setConfirmThreatOff(false);
    setConfirmToken("");
  }, []);

  async function setAdvertisingBlocking(enabled: boolean) {
    if (!enabled) {
      const confirmed = await api.showNativeConfirm(
        strings.settings.disableAdblockTitle,
        strings.settings.disableAdblockQuestion,
      );
      if (!confirmed) return;
    }
    await update({ blockAdvertisingAndTracking: enabled });
  }

  async function setThreatBlocking(enabled: boolean) {
    if (!enabled) {
      setConfirmToken("");
      setConfirmThreatOff(true);
      return;
    }
    await update({ blockReportedThreats: true });
  }

  async function confirmDisableThreats() {
    if (confirmToken !== strings.settings.threatDisableToken) return;
    cancelThreatOff();
    await update(
      { blockReportedThreats: false },
      strings.settings.threatDisableToken,
    );
  }

  return {
    confirmThreatOff,
    confirmToken,
    setConfirmToken,
    confirmInputRef,
    cancelThreatOff,
    setAdvertisingBlocking,
    setThreatBlocking,
    confirmDisableThreats,
  };
}
