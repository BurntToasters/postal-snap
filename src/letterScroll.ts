import { LruMap, SESSION_LIMIT } from "./lruMap";

const positions = new LruMap<number, number>(SESSION_LIMIT);

export function rememberLetterScroll(messageId: number, top: number): void {
  if (top <= 0) positions.delete(messageId);
  else positions.set(messageId, top);
}

export function rememberedLetterScroll(messageId: number): number {
  return positions.get(messageId) ?? 0;
}

/** Message ids are not account-scoped, so account removal clears all of them. */
export function forgetLetterScrolls(): void {
  positions.clear();
}

export function letterScrollKeys(): string[] {
  return positions.keys().map(String);
}
