const expanded = new Map<string, string[]>();

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
