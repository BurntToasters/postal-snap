/** Inclusive range in list order. The anchor stays put so the next shift-click can shrink or grow it. */
export function rangeSelection(
  orderedIds: number[],
  anchorId: number | undefined,
  targetId: number,
  cap = 200,
): { ids: number[]; capped: boolean } | undefined {
  const targetIndex = orderedIds.indexOf(targetId);
  if (targetIndex < 0 || cap < 1) return undefined;
  const anchorIndex =
    anchorId === undefined ? -1 : orderedIds.indexOf(anchorId);
  if (anchorIndex < 0) return { ids: [targetId], capped: false };
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const span = orderedIds.slice(start, end + 1);
  if (span.length <= cap) return { ids: span, capped: false };
  const step = targetIndex >= anchorIndex ? 1 : -1;
  const chosen = new Set<number>();
  for (let index = anchorIndex; chosen.size < cap; index += step) {
    chosen.add(orderedIds[index]);
  }
  return {
    ids: orderedIds.filter((id) => chosen.has(id)),
    capped: true,
  };
}
