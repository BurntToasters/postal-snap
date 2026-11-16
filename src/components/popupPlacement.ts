// Fixed placement for popup menus, portalled out of clipped containers.

/** Scroll cue: a fade at the bottom while more rows sit below the fold. */
export function syncScrollCue(node: HTMLElement) {
  const more = node.scrollHeight - node.scrollTop - node.clientHeight > 2;
  if (more) node.dataset.scrollCue = "more";
  else delete node.dataset.scrollCue;
}

/** Fixed placement beside an anchor, flipping above when there is no room. */
export function placeAnchoredMenu(menu: HTMLElement, trigger: HTMLElement) {
  const margin = 8;
  const gap = 6;
  const slot = trigger.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.margin = "0";
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.maxWidth = `${Math.max(0, window.innerWidth - margin * 2)}px`;
  menu.style.maxHeight = "";
  menu.style.visibility = "hidden";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const below = window.innerHeight - slot.bottom - gap - margin;
  const above = slot.top - gap - margin;
  const placeBelow = height <= below || below >= above;
  const room = Math.max(0, placeBelow ? below : above);
  // Use all space on the chosen side before the menu scrolls.
  menu.style.maxHeight = `${room}px`;
  const shown = Math.min(height, room);
  const left = Math.min(
    Math.max(margin, slot.right - width),
    Math.max(margin, window.innerWidth - width - margin),
  );
  const top = placeBelow
    ? slot.bottom + gap
    : Math.max(margin, slot.top - gap - shown);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "";
  syncScrollCue(menu);
}

export function placeSubmenuPanel(panel: HTMLElement, trigger: HTMLElement) {
  const edge = 8;
  const gap = 4;
  const anchor = trigger.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.left = "0px";
  panel.style.top = "0px";
  panel.style.maxHeight = `${window.innerHeight - edge * 2}px`;
  const { width, height } = panel.getBoundingClientRect();
  let left = anchor.right + gap;
  if (left + width > window.innerWidth - edge) {
    left = Math.max(edge, anchor.left - gap - width);
  }
  const top = Math.max(
    edge,
    Math.min(anchor.top - 5, window.innerHeight - edge - height),
  );
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  syncScrollCue(panel);
}
