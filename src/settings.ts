import type { AppSettings } from "./types";
import { syncWorkspaceWindowFx } from "./window-fx";

export function applySettings(settings: AppSettings) {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.density = settings.density;
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
