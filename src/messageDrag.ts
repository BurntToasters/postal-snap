/** Drag payload for moving loaded messages onto a folder. Ids only. */
import { strings } from "./i18n";

export const MESSAGE_DRAG_TYPE = "application/x-postal-snap-messages";

/** Left-edge band that opens the mailbox drawer during a drag. */
export const DRAG_EDGE_PX = 24;

let dragging = false;
let dragChip: HTMLElement | undefined;

export function beginMessageDrag(): void {
  dragging = true;
}

export function endMessageDrag(): void {
  dragging = false;
  dragChip?.remove();
  dragChip = undefined;
}

export function messageDragActive(): boolean {
  return dragging;
}

export function messageDragPayload(
  accountId: string,
  messageIds: number[],
): string {
  return `${accountId}\n${messageIds.join(",")}`;
}

/** Shows "N messages" as the drag image for multi-message drags. */
export function setMessageDragChip(
  transfer: DataTransfer,
  count: number,
): void {
  if (count < 2) return;
  dragChip?.remove();
  const chip = document.createElement("div");
  chip.className = "drag-chip";
  chip.textContent = strings.mail.dragMessageCount(count);
  document.body.append(chip);
  dragChip = chip;
  transfer.setDragImage(chip, 0, 0);
}

const DRAG_EDGE_CHECK_MS = 100;

/**
 * Opens the drawer when a message drag reaches the left edge, and closes it
 * again on dragend or drop only if this drag opened it. Returns the cleanup.
 */
export function watchDrawerDrag(
  isOpen: () => boolean,
  setOpen: (open: boolean) => void,
): () => void {
  let openedByDrag = false;
  let lastCheck = 0;
  // dragenter fires once per element, so a drag that stays in one element
  // never reaches the edge band; dragover repeats, so it is throttled instead.
  const over = (event: DragEvent) => {
    if (!dragging || event.clientX > DRAG_EDGE_PX) return;
    const now = performance.now();
    if (now - lastCheck < DRAG_EDGE_CHECK_MS) return;
    lastCheck = now;
    if (openedByDrag || isOpen()) return;
    openedByDrag = true;
    setOpen(true);
  };
  const finish = () => {
    lastCheck = 0;
    if (!openedByDrag) return;
    openedByDrag = false;
    setOpen(false);
  };
  window.addEventListener("dragover", over);
  window.addEventListener("drop", finish);
  window.addEventListener("dragend", finish);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("drop", finish);
    window.removeEventListener("dragend", finish);
  };
}

/** Ids for this account, or undefined when the payload is not ours. */
export function readMessageDrag(
  payload: string,
  accountId: string,
): number[] | undefined {
  const split = payload.split("\n");
  if (split.length !== 2 || split[0] !== accountId || !split[1])
    return undefined;
  const ids: number[] = [];
  for (const part of split[1].split(",")) {
    if (!/^[1-9]\d*$/.test(part)) return undefined;
    const id = Number(part);
    if (!Number.isSafeInteger(id)) return undefined;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}
