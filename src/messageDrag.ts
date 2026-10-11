/** Drag payload for moving loaded messages onto a folder. Ids only. */

export const MESSAGE_DRAG_TYPE = "application/x-postal-snap-messages";

let dragging = false;

export function beginMessageDrag(): void {
  dragging = true;
}

export function endMessageDrag(): void {
  dragging = false;
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
