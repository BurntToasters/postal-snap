/** Converts a px or rem length to CSS px. rem follows the root font size. */
function toPx(length: string): number {
  const value = length.trim();
  const amount = Number.parseFloat(value) || 0;
  if (!value.endsWith("rem")) return amount;
  const rootSize = getComputedStyle(document.documentElement).fontSize;
  return amount * (Number.parseFloat(rootSize) || 0);
}

/**
 * Positions a body-level menu beside its trigger. It opens above when that
 * side has more room, stays inside the visual viewport, and scrolls within
 * itself when it still does not fit.
 */
export function placeSendMenu(menu: HTMLElement, trigger: HTMLElement): void {
  // Gap and inset use --space-2; the top also clears native chrome.
  const rootStyle = getComputedStyle(document.documentElement);
  const space = toPx(rootStyle.getPropertyValue("--space-2"));
  const chrome = toPx(rootStyle.getPropertyValue("--native-chrome-height"));
  const view = window.visualViewport;
  const viewLeft = view?.offsetLeft ?? 0;
  const viewTop = view?.offsetTop ?? 0;
  const viewWidth = view?.width ?? window.innerWidth;
  const viewHeight = view?.height ?? window.innerHeight;
  const anchor = trigger.getBoundingClientRect();

  // Clear the old placement so the menu measures at its natural size.
  menu.style.maxHeight = "";
  menu.style.top = "";
  menu.style.left = "";
  const full = menu.getBoundingClientRect();

  const topEdge = viewTop + chrome + space;
  const spaceAbove = anchor.top - space - topEdge;
  const spaceBelow = viewTop + viewHeight - space - (anchor.bottom + space);
  const above = full.height > spaceBelow && spaceAbove > spaceBelow;
  const room = Math.max(above ? spaceAbove : spaceBelow, 0);
  const height = Math.min(full.height, room);
  const top = above ? anchor.top - space - height : anchor.bottom + space;
  const maxLeft = viewLeft + viewWidth - space - full.width;
  const left = Math.max(viewLeft + space, Math.min(anchor.left, maxLeft));

  menu.style.maxHeight = `${room}px`;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}
