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
