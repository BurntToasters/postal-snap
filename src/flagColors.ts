import { strings } from "./i18n";
import type { FlagColor } from "./types";

/** Color indexes in menu order; the index is what the backend stores. */
export const FLAG_COLORS: readonly FlagColor[] = [0, 1, 2, 3, 4, 5, 6];

const FLAG_COLOR_KEYS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
] as const;

/** Localized color name. Unknown or missing indexes read as red. */
export function flagColorName(color: number | null | undefined): string {
  return strings.mail.flagColors[FLAG_COLOR_KEYS[color ?? 0] ?? "red"];
}

/** Color names for menu labels, in FLAG_COLORS order. */
export const flagColorKeys = FLAG_COLOR_KEYS;
