import { useAppStore } from "./store";
import type { AccountSummary } from "./types";

export type AccountPatch = Partial<Omit<AccountSummary, "id">>;

/**
 * Merges only the fields one save owns into the latest store account.
 * Responses can be older snapshots, so whole-account replacement is unsafe.
 */
export function mergeAccountFields(accountId: string, fields: AccountPatch) {
  const { accounts, setAccounts } = useAppStore.getState();
  setAccounts(
    accounts.map((item) =>
      item.id === accountId ? { ...item, ...fields } : item,
    ),
  );
}

/**
 * Applies a listed snapshot without reverting identity fields: keeps store
 * order and merges only sync status for accounts still present, appends new
 * accounts, and drops accounts the list no longer contains.
 */
export function reconcileAccountList(listed: AccountSummary[]) {
  const { accounts, setAccounts } = useAppStore.getState();
  const listedById = new Map(listed.map((item) => [item.id, item]));
  const knownIds = new Set(accounts.map((item) => item.id));
  const kept = accounts.flatMap((item) => {
    const fresh = listedById.get(item.id);
    return fresh
      ? [{ ...item, syncState: fresh.syncState, error: fresh.error }]
      : [];
  });
  const added = listed.filter((item) => !knownIds.has(item.id));
  setAccounts([...kept, ...added]);
}
