import type { ActionId } from "./types";

// Wire-compatible with the untyped window event that existing listeners use.
export const MENU_ACTION_EVENT = "postal:menu-action";

export function emitAction(id: ActionId): void {
  window.dispatchEvent(
    new CustomEvent<ActionId>(MENU_ACTION_EVENT, { detail: id }),
  );
}

export function onAction(handler: (id: ActionId) => void): () => void {
  const listener = (event: Event) =>
    handler((event as CustomEvent<ActionId>).detail);
  window.addEventListener(MENU_ACTION_EVENT, listener);
  return () => window.removeEventListener(MENU_ACTION_EVENT, listener);
}
