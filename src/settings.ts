import type { AppSettings, SettingsPatch } from "./types";
import { syncWorkspaceWindowFx } from "./window-fx";

export function offersCloseToTray(
  platform = document.documentElement.dataset.platform,
): boolean {
  return platform === "windows" || platform === "macos";
}

export function closesToTrayOnClose(
  settings: Pick<AppSettings, "closeToTray">,
  platform = document.documentElement.dataset.platform,
): boolean {
  return offersCloseToTray(platform) && settings.closeToTray;
}

let systemThemeMedia: MediaQueryList | undefined;
let systemThemeListener: (() => void) | undefined;

function clearSystemThemeListener() {
  if (systemThemeMedia && systemThemeListener) {
    systemThemeMedia.removeEventListener?.("change", systemThemeListener);
  }
  systemThemeMedia = undefined;
  systemThemeListener = undefined;
}

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const CACHED_THEME_KEY = "postal-snap.theme";
let resolvedThemeSetting: AppSettings["theme"] = "system";
let schemeListenerAttached = false;

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_SCHEME_QUERY).matches
  );
}

/** Light or dark for a theme setting; system follows the OS appearance. */
export function resolveTheme(theme: AppSettings["theme"]): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return systemPrefersDark() ? "dark" : "light";
}

function writeResolvedTheme() {
  document.documentElement.dataset.resolvedTheme =
    resolveTheme(resolvedThemeSetting);
}

/** Last theme seen, so the first paint matches it before settings load. */
export function cachedThemeSetting(): AppSettings["theme"] {
  try {
    const value = window.localStorage.getItem(CACHED_THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Sets html[data-resolved-theme] and follows system appearance changes live. */
export function applyResolvedTheme(theme: AppSettings["theme"]) {
  resolvedThemeSetting = theme;
  try {
    window.localStorage.setItem(CACHED_THEME_KEY, theme);
  } catch {
    // Storage can be blocked; the first paint then falls back to system.
  }
  writeResolvedTheme();
  if (schemeListenerAttached || typeof window.matchMedia !== "function") return;
  schemeListenerAttached = true;
  window
    .matchMedia(DARK_SCHEME_QUERY)
    .addEventListener?.("change", writeResolvedTheme);
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

/** Stable address form for remembered image consent. Empty when it is not an address. */
export function normalizeImageSender(value: string): string {
  const address = value.trim().toLowerCase();
  const length = Array.from(address).length;
  if (length < 3 || length > 200) return "";
  if (
    Array.from(address).some(
      (character) => character <= " " || character === "\u007f",
    )
  ) {
    return "";
  }
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@") || at === address.length - 1)
    return "";
  return address;
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
  applyResolvedTheme(settings.theme);
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

  void syncWorkspaceWindowFx(settings.windowEffects, settings.theme === "dark");
}
