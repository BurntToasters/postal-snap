import { PostalError } from "../../errors";
import type { MessageSummary } from "../../types";

export function isOversizeError(cause: unknown): boolean {
  if (cause instanceof PostalError) return cause.code === "limitExceeded";
  return /too large|exceeds.*safety limit/i.test(String(cause));
}

export function mergeSearchResults(
  localItems: MessageSummary[],
  serverItems: MessageSummary[],
): MessageSummary[] {
  // Cached FTS uses AND of up to 12 terms ranked by bm25; server uses IMAP
  // TEXT phrase matching. Keep cached rank order, then append server-only
  // body matches newest-first so server hits are not filtered through FTS.
  const seen = new Set<number>();
  const merged: MessageSummary[] = [];
  for (const item of localItems) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  const serverOnly = serverItems
    .filter((item) => !seen.has(item.id))
    .sort(
      (a, b) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );
  for (const item of serverOnly) {
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function matchesLocalQuery(value: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return value.toLowerCase().includes(needle);
}
