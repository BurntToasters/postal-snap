import type { KeyboardEvent } from "react";

const toolbarFocusable =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function moveToolbarFocus(event: KeyboardEvent<HTMLElement>) {
  if (
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  const toolbar = event.currentTarget;
  const items = [
    ...toolbar.querySelectorAll<HTMLElement>(toolbarFocusable),
  ].filter(
    (item) =>
      !item.hidden &&
      (typeof item.checkVisibility === "function"
        ? item.checkVisibility()
        : item.offsetParent !== null || item.getClientRects().length > 0),
  );
  if (items.length === 0) return;
  event.stopPropagation();
  const active = document.activeElement as HTMLElement | null;
  let index = items.findIndex(
    (item) => item === active || item.contains(active),
  );
  if (index === -1) return;
  event.preventDefault();
  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = items.length - 1;
  else if (event.key === "ArrowRight") index = (index + 1) % items.length;
  else index = (index - 1 + items.length) % items.length;
  items[index].focus();
}

// Typeahead: a printable key jumps to the next item whose visible label
// starts with it, wrapping around.
function focusMenuItemByLetter(event: KeyboardEvent<HTMLElement>) {
  if (
    event.target instanceof HTMLElement &&
    event.target.matches("input, textarea, select")
  ) {
    return;
  }
  const letter = event.key.toLocaleLowerCase();
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    ),
  ];
  const start = items.findIndex((item) => item === document.activeElement);
  for (let step = 1; step <= items.length; step += 1) {
    const item = items[(start + step) % items.length];
    const label = item.textContent?.trim().toLocaleLowerCase() ?? "";
    if (label.startsWith(letter)) {
      event.preventDefault();
      event.stopPropagation();
      item.focus();
      return;
    }
  }
}

export function moveMenuFocus(event: KeyboardEvent<HTMLElement>) {
  if (
    event.key.length === 1 &&
    event.key.trim() &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    focusMenuItemByLetter(event);
    return;
  }
  if (
    event.key !== "ArrowUp" &&
    event.key !== "ArrowDown" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]), select:not([disabled])',
    ),
  ].filter(
    (item) =>
      !item.hidden &&
      (typeof item.checkVisibility === "function"
        ? item.checkVisibility()
        : item.offsetParent !== null || item.getClientRects().length > 0),
  );
  if (items.length === 0) return;
  event.stopPropagation();
  const active = document.activeElement as HTMLElement | null;
  let index = items.findIndex(
    (item) => item === active || item.contains(active),
  );
  event.preventDefault();
  if (event.key === "Home") index = 0;
  else if (event.key === "End") index = items.length - 1;
  else if (event.key === "ArrowDown") index = (index + 1) % items.length;
  else index = (index - 1 + items.length) % items.length;
  items[index].focus();
}
