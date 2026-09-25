import type { AccountSummary, SyncPhase, SyncState } from "./types";

export function accountSyncPhase(
  account: AccountSummary | undefined,
  live: SyncState | undefined,
): SyncPhase {
  return live?.phase ?? account?.syncState ?? "idle";
}

export function accountCannotSend(
  account: AccountSummary | undefined,
  live: SyncState | undefined,
): boolean {
  const phase = accountSyncPhase(account, live);
  return phase === "offline" || phase === "authFailed";
}
