import type { AppSettings, SettingsPatch } from "./types";
import { syncWorkspaceWindowFx } from "./window-fx";

export function mergeSettingsPatches(
  current: SettingsPatch,
  patch: SettingsPatch,
): SettingsPatch {
  const merged: SettingsPatch = { ...current, ...patch };
  if (current.cachePolicy && patch.cachePolicy) {
    merged.cachePolicy = { ...current.cachePolicy, ...patch.cachePolicy };
  }
  return merged;
}

export function applySettingsPatch(
  base: AppSettings,
  patch: SettingsPatch,
): AppSettings {
  return {
    ...base,
    ...patch,
    cachePolicy: patch.cachePolicy
      ? { ...base.cachePolicy, ...patch.cachePolicy }
      : base.cachePolicy,
  };
}

export function applySettings(settings: AppSettings) {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.density = settings.density;
  document.documentElement.dataset.textScale =
    settings.textScale >= 1.5 ? "large" : "normal";
  document.documentElement.style.fontSize = `${settings.textScale * 100}%`;

  // Native window blur / vibrancy (macOS vibrancy, Windows Mica / Acrylic, mirrored from Zinnia).
  // Everything but the rendered email gets it; the email stays opaque.
  const isDark =
    settings.theme === "dark" ||
    (settings.theme === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
  void syncWorkspaceWindowFx(settings.windowEffects, Boolean(isDark));
}
