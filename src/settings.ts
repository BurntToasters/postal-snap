import type { AppSettings, SettingsPatch } from "./types";
import { syncWorkspaceWindowFx } from "./window-fx";

let systemThemeMedia: MediaQueryList | undefined;
let systemThemeListener: (() => void) | undefined;

function clearSystemThemeListener() {
  if (systemThemeMedia && systemThemeListener) {
    systemThemeMedia.removeEventListener?.("change", systemThemeListener);
  }
  systemThemeMedia = undefined;
  systemThemeListener = undefined;
}

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

  // Keep native material tint synchronized with the effective system theme.
  clearSystemThemeListener();
  if (
    settings.theme === "system" &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () =>
      void syncWorkspaceWindowFx(settings.windowEffects, media.matches);
    systemThemeMedia = media;
    systemThemeListener = sync;
    media.addEventListener?.("change", sync);
    sync();
    return;
  }

  void syncWorkspaceWindowFx(
    settings.windowEffects,
    settings.theme === "dark",
  );
}
