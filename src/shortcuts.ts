import { listActions } from "./actions/registry";

export interface ShortcutItem {
  id: string;
  label: string;
  keys: string;
}

export function getShortcutsRegistry(): ShortcutItem[] {
  return listActions().flatMap((action) =>
    action.hint
      ? [{ id: action.id, label: action.label(), keys: action.hint() }]
      : [],
  );
}
