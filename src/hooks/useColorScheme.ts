import { useSyncExternalStore } from "react";
import { useAppStore } from "../store";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(DARK_QUERY);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

function systemPrefersDark() {
  return window.matchMedia?.(DARK_QUERY)?.matches ?? false;
}

/** True when Postal Snap draws in dark mode (setting or system). */
export function useIsDark(): boolean {
  const theme = useAppStore((state) => state.settings.theme);
  const systemDark = useSyncExternalStore(
    subscribe,
    systemPrefersDark,
    () => false,
  );
  return theme === "dark" || (theme !== "light" && systemDark);
}
