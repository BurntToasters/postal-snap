const positions = new Map<number, number>();

export function rememberLetterScroll(messageId: number, top: number): void {
  if (top <= 0) positions.delete(messageId);
  else positions.set(messageId, top);
}

export function rememberedLetterScroll(messageId: number): number {
  return positions.get(messageId) ?? 0;
}
