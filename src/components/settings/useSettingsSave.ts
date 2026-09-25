import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  applySettings,
  applySettingsPatch,
  mergeSettingsPatches,
} from "../../settings";
import { useAppStore } from "../../store";
import type { SettingsPatch } from "../../types";

export interface SettingsSaveOptions {
  // Background writes (for example setup progress) fail silently unless a
  // user-made change shares the same batch.
  quiet?: boolean;
}

export type SettingsSaveUpdate = (
  patch: SettingsPatch,
  confirmToken?: string,
  options?: SettingsSaveOptions,
) => Promise<void>;

// onError replaces the default global error banner (setup has no banner).
export function useSettingsSave(onError?: (cause: unknown) => void) {
  const setSettings = useAppStore((state) => state.setSettings);
  const setError = useAppStore((state) => state.setError);
  const [saving, setSaving] = useState(false);
  const pendingSettingsPatch = useRef<SettingsPatch>({});
  const pendingConfirmToken = useRef<string | undefined>(undefined);
  const settingsSaveChain = useRef(Promise.resolve());
  const onErrorRef = useRef(onError);
  const pendingReportsError = useRef(false);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Stable identity so effects can depend on it without re-running.
  const update = useCallback(
    function update(
      patch: SettingsPatch,
      confirmToken?: string,
      options?: SettingsSaveOptions,
    ) {
      pendingSettingsPatch.current = mergeSettingsPatches(
        pendingSettingsPatch.current,
        patch,
      );
      if (confirmToken) pendingConfirmToken.current = confirmToken;
      if (!options?.quiet) pendingReportsError.current = true;
      const queued = settingsSaveChain.current.then(async () => {
        const merged = pendingSettingsPatch.current;
        const token = pendingConfirmToken.current;
        pendingSettingsPatch.current = {};
        pendingConfirmToken.current = undefined;
        const reportsError = pendingReportsError.current;
        pendingReportsError.current = false;
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
          if (!reportsError) return;
          if (onErrorRef.current) onErrorRef.current(cause);
          else setError(String(cause));
        } finally {
          setSaving(false);
        }
      });
      settingsSaveChain.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [setError, setSettings],
  );

  return { saving, update };
}
