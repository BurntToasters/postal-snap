import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  applySettings,
  applySettingsPatch,
  mergeSettingsPatches,
} from "../../settings";
import { useAppStore } from "../../store";
import type { AppSettings, SettingsPatch } from "../../types";

export interface SettingsSaveOptions {
  // Background writes (for example setup progress) fail silently unless a
  // user-made change shares the same batch.
  quiet?: boolean;
  // Values to restore when a caller has already applied an optimistic update.
  rollback?: SettingsPatch;
}

export type SettingsSaveUpdate = (
  patch: SettingsPatch,
  confirmToken?: string,
  options?: SettingsSaveOptions,
) => Promise<void>;

// One chain for the whole app: every caller's full-settings write runs in
// order, so a later save always includes earlier ones.
let sharedSaveChain: Promise<void> = Promise.resolve();

// Undo only the fields this batch changed, on top of the latest settings, so
// a failure never discards another caller's newer change.
function revertFields(
  latest: AppSettings,
  previous: AppSettings,
  patch: SettingsPatch,
  rollbackPatch: SettingsPatch,
): AppSettings {
  const reverted: Record<string, unknown> = { ...latest };
  for (const key of Object.keys(patch)) {
    const field = key as keyof AppSettings;
    const hasRollbackValue = Object.prototype.hasOwnProperty.call(
      rollbackPatch,
      key,
    );
    reverted[key] = hasRollbackValue ? rollbackPatch[field] : previous[field];
  }
  return reverted as unknown as AppSettings;
}

// onError replaces the default global error banner (setup has no banner).
export function useSettingsSave(onError?: (cause: unknown) => void) {
  const setSettings = useAppStore((state) => state.setSettings);
  const setError = useAppStore((state) => state.setError);
  const [saving, setSaving] = useState(false);
  const pendingSettingsPatch = useRef<SettingsPatch>({});
  const pendingRollbackPatch = useRef<SettingsPatch>({});
  const pendingConfirmToken = useRef<string | undefined>(undefined);
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
      if (options?.rollback) {
        // Keep the earliest rollback value when calls coalesce into one save.
        pendingRollbackPatch.current = mergeSettingsPatches(
          options.rollback,
          pendingRollbackPatch.current,
        );
      }
      if (confirmToken) pendingConfirmToken.current = confirmToken;
      if (!options?.quiet) pendingReportsError.current = true;
      const queued = sharedSaveChain.then(async () => {
        const merged = pendingSettingsPatch.current;
        const rollbackPatch = pendingRollbackPatch.current;
        const token = pendingConfirmToken.current;
        pendingSettingsPatch.current = {};
        pendingRollbackPatch.current = {};
        pendingConfirmToken.current = undefined;
        const reportsError = pendingReportsError.current;
        pendingReportsError.current = false;
        if (Object.keys(merged).length === 0 && !token) return;
        const previous = useAppStore.getState().settings;
        const next = applySettingsPatch(previous, merged);
        // Quiet background writes should not disable the caller's buttons.
        if (reportsError) setSaving(true);
        try {
          setSettings(next);
          applySettings(next);
          const saved = token
            ? await api.saveSettings(next, token)
            : await api.saveSettings(next);
          setSettings(saved);
          applySettings(saved);
        } catch (cause) {
          const reverted = revertFields(
            useAppStore.getState().settings,
            previous,
            merged,
            rollbackPatch,
          );
          setSettings(reverted);
          applySettings(reverted);
          if (!reportsError) return;
          if (onErrorRef.current) onErrorRef.current(cause);
          else setError(String(cause));
        } finally {
          if (reportsError) setSaving(false);
        }
      });
      sharedSaveChain = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [setError, setSettings],
  );

  return { saving, update };
}
