import { strings } from "../../i18n";
import type { AppSettings } from "../../types";

// Single source for display choices used by Settings, setup, and shortcuts.
export const THEME_CHOICES: ReadonlyArray<{
  value: AppSettings["theme"];
  label: string;
}> = [
  { value: "system", label: strings.settings.autoDefault },
  { value: "light", label: strings.settings.light },
  { value: "dark", label: strings.settings.dark },
];

export const DENSITY_CHOICES: ReadonlyArray<{
  value: AppSettings["density"];
  label: string;
}> = [
  { value: "comfortable", label: strings.settings.comfortable },
  { value: "compact", label: strings.settings.compact },
];

export const TEXT_SCALE_CHOICES: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 0.85, label: strings.settings.small },
  { value: 1, label: strings.settings.normal },
  { value: 1.15, label: strings.settings.large },
  { value: 1.3, label: strings.settings.extraLarge },
  { value: 1.5, label: strings.settings.veryLarge },
  { value: 1.75, label: strings.settings.evenLarger },
  { value: 2, label: strings.settings.largest },
];

export const TEXT_SCALES = TEXT_SCALE_CHOICES.map((choice) => choice.value);

export const READING_PANE_CHOICES: ReadonlyArray<{
  value: AppSettings["readingPane"];
  label: string;
}> = [
  { value: "right", label: strings.settings.paneRight },
  { value: "bottom", label: strings.settings.paneBottom },
  { value: "hidden", label: strings.settings.paneHidden },
];
