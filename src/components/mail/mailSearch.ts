import { PostalError } from "../../errors";
import type { MessageSummary } from "../../types";

export function isOversizeError(cause: unknown): boolean {
  if (cause instanceof PostalError) {
    return (
      cause.code === "limitExceeded" ||
      /too large|exceeds.*safety limit/i.test(cause.message)
    );
  }
  const raw = cause instanceof Error ? cause.message : "";
  return /too large|exceeds.*safety limit/i.test(raw);
}

export function mergeSearchResults(
  localItems: MessageSummary[],
  serverItems: MessageSummary[],
): MessageSummary[] {
  // Cached FTS ranks operator and text terms by weighted bm25; the server
  // maps the same operators to IMAP keys. Keep cached rank order, then append
  // server-only body matches newest-first so they skip the FTS filter.
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

/** Adds a continued server search page, newest first, skipping known rows. */
export function appendServerSearchResults(
  current: MessageSummary[],
  more: MessageSummary[],
): MessageSummary[] {
  const seen = new Set(current.map((item) => `${item.mailboxId}:${item.uid}`));
  const added: MessageSummary[] = [];
  for (const item of more) {
    const key = `${item.mailboxId}:${item.uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(item);
  }
  added.sort(
    (a, b) =>
      new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
  );
  return [...current, ...added];
}

export function matchesLocalQuery(value: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return value.toLowerCase().includes(needle);
}
