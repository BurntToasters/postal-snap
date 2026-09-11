import { useRef, useState } from "react";
import { api } from "../../api";
import {
  applySettings,
  applySettingsPatch,
  mergeSettingsPatches,
} from "../../settings";
import { useAppStore } from "../../store";
import type { SettingsPatch } from "../../types";

export type SettingsSaveUpdate = (
  patch: SettingsPatch,
  confirmToken?: string,
) => Promise<void>;

export function useSettingsSave() {
  const setSettings = useAppStore((state) => state.setSettings);
  const setError = useAppStore((state) => state.setError);
  const [saving, setSaving] = useState(false);
  const pendingSettingsPatch = useRef<SettingsPatch>({});
  const pendingConfirmToken = useRef<string | undefined>(undefined);
  const settingsSaveChain = useRef(Promise.resolve());

  function update(patch: SettingsPatch, confirmToken?: string) {
    pendingSettingsPatch.current = mergeSettingsPatches(
      pendingSettingsPatch.current,
      patch,
    );
    if (confirmToken) pendingConfirmToken.current = confirmToken;
    const queued = settingsSaveChain.current.then(async () => {
      const merged = pendingSettingsPatch.current;
      const token = pendingConfirmToken.current;
      pendingSettingsPatch.current = {};
      pendingConfirmToken.current = undefined;
      if (Object.keys(merged).length === 0 && !token) return;
      const previous = useAppStore.getState().settings;
      const next = applySettingsPatch(previous, merged);
      setSaving(true);
      setSettings(next);
      applySettings(next);
      try {
        const saved = token
          ? await api.saveSettings(next, token)
          : await api.saveSettings(next);
        setSettings(saved);
        applySettings(saved);
      } catch (cause) {
        setSettings(previous);
        applySettings(previous);
        setError(String(cause));
      } finally {
        setSaving(false);
      }
    });
    settingsSaveChain.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  return { saving, update };
}
