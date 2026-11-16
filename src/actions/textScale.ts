import { TEXT_SCALES } from "../components/settings/displayChoices";
import type { SettingsSaveUpdate } from "../components/settings/useSettingsSave";
import { useAppStore } from "../store";

// Shared by the keyboard and native menus so rapid presses stack.
let pendingScale: number | null = null;

/** Steps the text size one notch from the pending or saved value. */
export function stepTextScale(delta: 1 | -1, update: SettingsSaveUpdate): void {
  const scales = TEXT_SCALES;
  const currentScale =
    pendingScale ?? useAppStore.getState().settings.textScale;
  const current = scales.reduce(
    (closest, value) =>
      Math.abs(value - currentScale) < Math.abs(closest - currentScale)
        ? value
        : closest,
    1,
  );
  const nextIndex = Math.max(
    0,
    Math.min(scales.length - 1, scales.indexOf(current) + delta),
  );
  const nextScale = scales[nextIndex];
  pendingScale = nextScale;
  void update({ textScale: nextScale }).finally(() => {
    if (pendingScale === nextScale) pendingScale = null;
  });
}
