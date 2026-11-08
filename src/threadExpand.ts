import { LruMap, SESSION_LIMIT } from "./lruMap";

// Keys share the list scrollKey shape, `${accountId}:...`.
const expanded = new LruMap<string, string[]>(SESSION_LIMIT);

export function rememberExpandedThreads(key: string, keys: string[]): void {
  if (keys.length === 0) expanded.delete(key);
  else expanded.set(key, keys);
}

/** Test-only reset: drops every remembered expanded thread. */
export function clearRememberedExpandedThreads(): void {
  expanded.clear();
}

export function rememberedExpandedThreads(key: string): string[] {
  return expanded.get(key) ?? [];
}

export function forgetExpandedThreadsForAccount(accountId: string): void {
  expanded.deleteWhere((key) => key.startsWith(`${accountId}:`));
}

export function expandedThreadKeys(): string[] {
  return expanded.keys();
}
