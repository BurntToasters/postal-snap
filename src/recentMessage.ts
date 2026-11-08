import { LruMap, SESSION_LIMIT } from "./lruMap";

const lastOpen = new LruMap<string, number>(SESSION_LIMIT);

function key(accountId: string, mailboxId: number): string {
  return `${accountId}:${mailboxId}`;
}

export function rememberOpenMessage(
  accountId: string,
  mailboxId: number,
  messageId: number,
): void {
  lastOpen.set(key(accountId, mailboxId), messageId);
}

export function forgetOpenMessage(accountId: string, mailboxId: number): void {
  lastOpen.delete(key(accountId, mailboxId));
}

export function forgetOpenMessagesForAccount(accountId: string): void {
  lastOpen.deleteWhere((entry) => entry.startsWith(`${accountId}:`));
}

/** Test-only reset: drops every remembered open message. */
export function clearRememberedOpenMessages(): void {
  lastOpen.clear();
}

export function rememberedOpenMessage(
  accountId: string,
  mailboxId: number,
): number | undefined {
  return lastOpen.get(key(accountId, mailboxId));
}

export function openMessageKeys(): string[] {
  return lastOpen.keys();
}
