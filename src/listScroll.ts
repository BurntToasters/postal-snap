import { LruMap, SESSION_LIMIT } from "./lruMap";

// Keys start with `${accountId}:` (see MailShell scrollKey).
const positions = new LruMap<string, number>(SESSION_LIMIT);

export function rememberListScroll(key: string, top: number): void {
  if (top <= 0) positions.delete(key);
  else positions.set(key, top);
}

export function rememberedListScroll(key: string): number {
  return positions.get(key) ?? 0;
}

export function forgetListScrollsForAccount(accountId: string): void {
  positions.deleteWhere((key) => key.startsWith(`${accountId}:`));
}

export function listScrollKeys(): string[] {
  return positions.keys();
}
