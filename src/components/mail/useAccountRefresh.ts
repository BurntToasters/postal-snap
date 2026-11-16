import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { errorText } from "../../errors";

interface AccountRefreshOptions {
  activeAccountId?: string;
  submittedQueryRef: MutableRefObject<string>;
  loadAccountData: () => Promise<void>;
  loadAccountCounts: () => Promise<void>;
  loadMessages: () => Promise<void>;
  runSearch: () => Promise<void>;
  setError: (message: string) => void;
}

// Owns sync progress for "Get mail" and "Get mail for all accounts".
export function useAccountRefresh({
  activeAccountId,
  submittedQueryRef,
  loadAccountData,
  loadAccountCounts,
  loadMessages,
  runSearch,
  setError,
}: AccountRefreshOptions) {
  const [syncingAllAccounts, setSyncingAllAccounts] = useState(false);
  const [syncingAccountIds, setSyncingAccountIds] = useState<Set<string>>(
    () => new Set(),
  );
  const syncingAccountIdsRef = useRef(new Set<string>());
  const syncingAllRef = useRef(false);

  const refreshAccount = useCallback(
    async (accountId: string) => {
      if (syncingAccountIdsRef.current.has(accountId)) return;
      syncingAccountIdsRef.current.add(accountId);
      setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
      try {
        await api.syncAccount(accountId);
        if (useAppStore.getState().activeAccountId === accountId) {
          await loadAccountData();
          if (submittedQueryRef.current) await runSearch();
          else await loadMessages();
        }
      } catch (cause) {
        if (useAppStore.getState().activeAccountId === accountId) {
          setError(errorText(cause));
        }
      } finally {
        syncingAccountIdsRef.current.delete(accountId);
        setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
      }
    },
    [loadAccountData, loadMessages, runSearch, setError, submittedQueryRef],
  );

  const refresh = useCallback(async () => {
    if (activeAccountId) await refreshAccount(activeAccountId);
  }, [activeAccountId, refreshAccount]);

  // Same progress and error handling as one account; counts come from STATUS.
  const refreshAllAccounts = useCallback(async () => {
    if (syncingAllRef.current) return;
    syncingAllRef.current = true;
    setSyncingAllAccounts(true);
    const ids = useAppStore.getState().accounts.map((account) => account.id);
    // Only claim accounts no single refresh already owns.
    const claimed = ids.filter((id) => !syncingAccountIdsRef.current.has(id));
    for (const id of claimed) syncingAccountIdsRef.current.add(id);
    setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
    try {
      const synced = await api.syncAllAccounts();
      const failed = ids.filter((id) => !synced.includes(id)).length;
      if (failed > 0) setError(strings.mail.refreshAllPartial(failed));
      // Accounts added during the sync were absent from the start snapshot.
      const added = useAppStore
        .getState()
        .accounts.map((account) => account.id)
        .filter((id) => !ids.includes(id));
      for (const id of added) await refreshAccount(id);
      await loadAccountCounts();
      if (useAppStore.getState().activeAccountId) {
        await loadAccountData();
        if (submittedQueryRef.current) await runSearch();
        else await loadMessages();
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      for (const id of claimed) syncingAccountIdsRef.current.delete(id);
      setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
      syncingAllRef.current = false;
      setSyncingAllAccounts(false);
    }
  }, [
    loadAccountCounts,
    loadAccountData,
    loadMessages,
    refreshAccount,
    runSearch,
    setError,
    submittedQueryRef,
  ]);

  async function refreshList() {
    if (submittedQueryRef.current) await runSearch();
    else await loadMessages();
  }

  return {
    syncingAccountIds,
    syncingAllAccounts,
    refresh,
    refreshAccount,
    refreshAllAccounts,
    refreshList,
  };
}
