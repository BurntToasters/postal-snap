import type { AppSettings } from "./types";

export function applySettings(settings: AppSettings) {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.density = settings.density;
  document.documentElement.style.fontSize = `${settings.textScale * 100}%`;
}
