import { useEffect } from "react";
import { emitAction } from "../actions/bus";
import { matchShortcut } from "../actions/match";
import { stepTextScale } from "../actions/textScale";
import type { SettingsSaveUpdate } from "../components/settings/useSettingsSave";

/** App-wide chords that must work before the mail shell mounts (setup, errors). */
export function useAppShortcuts(
  openSettings: () => void,
  updateSettings: SettingsSaveUpdate,
) {
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const id = matchShortcut(event, { allowModal: true });
      if (id === "settings") {
        if (document.querySelector(".composer-layer, .modal-layer")) return;
        event.preventDefault();
        openSettings();
      } else if (id === "text-larger" || id === "text-smaller") {
        event.preventDefault();
        stepTextScale(id === "text-larger" ? 1 : -1, updateSettings);
      } else if (id === "print") {
        // Printing stays blocked behind any dialog, as before.
        if (
          document.querySelector(
            ".composer-layer, .settings-window, .modal-layer",
          )
        )
          return;
        event.preventDefault();
        emitAction("print");
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [openSettings, updateSettings]);
}
