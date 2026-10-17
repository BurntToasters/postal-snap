import { listActions } from "./registry";
import type { ActionId, ShortcutSpec } from "./types";

const EDITABLE_SELECTOR =
  "input,textarea,select,[contenteditable='true'],[role='combobox'],[role='textbox']";
const CHROME_SELECTOR =
  "button, a, [role='menuitem'], .reader-actions, .format-toolbar, .settings-nav, .bulk-bar";
const MODIFIERS = ["mod", "shift", "alt", "ctrl", "meta"] as const;

type Modifier = (typeof MODIFIERS)[number];

/** Command on macOS, where Control keys edit text; Command or Control elsewhere. */
export function isShortcutModifier(event: KeyboardEvent): boolean {
  return document.documentElement.dataset.platform === "macos"
    ? event.metaKey
    : event.metaKey || event.ctrlKey;
}

function focusAllows(
  focus: NonNullable<ShortcutSpec["focus"]>,
  target: EventTarget | null,
): boolean {
  if (focus === "any") return true;
  const element = target instanceof HTMLElement ? target : null;
  if (element?.matches(EDITABLE_SELECTOR)) return false;
  if (focus === "not-editing") return true;
  return !(
    element?.closest(CHROME_SELECTOR) && !element.closest(".message-list")
  );
}

function keyMatches(spec: ShortcutSpec, event: KeyboardEvent): boolean {
  if (spec.code !== undefined && event.code === spec.code) return true;
  const key = event.key.toLowerCase();
  const keys = typeof spec.key === "string" ? [spec.key] : spec.key;
  return keys.some((candidate) => candidate.toLowerCase() === key);
}

function modifiersMatch(
  spec: ShortcutSpec,
  state: Record<Modifier, boolean>,
): boolean {
  return MODIFIERS.every(
    (name) => spec[name] === undefined || spec[name] === state[name],
  );
}

/**
 * Returns the action bound to a key press. Specs with more modifier
 * constraints win; registry order breaks ties.
 */
export function matchShortcut(event: KeyboardEvent): ActionId | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (document.querySelector(".modal-layer")) return undefined;
  const state: Record<Modifier, boolean> = {
    mod: isShortcutModifier(event),
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
  };
  let match: ActionId | undefined;
  let best = -1;
  for (const action of listActions()) {
    for (const spec of action.shortcut ?? []) {
      if (!keyMatches(spec, event)) continue;
      if (!modifiersMatch(spec, state)) continue;
      if (!focusAllows(spec.focus ?? "idle", event.target)) continue;
      const specificity = MODIFIERS.filter(
        (name) => spec[name] !== undefined,
      ).length;
      if (specificity > best) {
        best = specificity;
        match = action.id;
      }
    }
  }
  return match;
}
