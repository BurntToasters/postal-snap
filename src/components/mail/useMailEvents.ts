import { useEffect, type MutableRefObject } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";

type AppState = ReturnType<typeof useAppStore.getState>;

interface Options {
  loadAccountCounts: () => Promise<void>;
  loadersRef: MutableRefObject<{
    loadAccountData: () => Promise<void>;
    loadMessages: () => Promise<void>;
    runSearch: () => Promise<void>;
  }>;
  submittedQueryRef: MutableRefObject<string>;
  setError: AppState["setError"];
}

export function useMailEvents({
  loadAccountCounts,
  loadersRef,
  submittedQueryRef,
  setError,
}: Options) {
  useEffect(() => {
    let active = true;
    const unsubs: Array<() => void> = [];
    void api
      .onFolderCountsChanged(({ accountId }) => {
        void loadAccountCounts();
        if (accountId === useAppStore.getState().activeAccountId)
          void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onMessageChanged(({ accountId, messageId, kind }) => {
        const store = useAppStore.getState();
        if (accountId !== store.activeAccountId) return;
        if (submittedQueryRef.current) void loadersRef.current.runSearch();
        else void loadersRef.current.loadMessages();
        if (
          messageId &&
          store.selectedMessage?.id === messageId &&
          kind === "moved"
        ) {
          store.selectMessage(undefined);
        }
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onDraftSyncChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onOutboxChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onSyncProgress((progress) => {
        if (progress.accountId === useAppStore.getState().activeAccountId)
          useAppStore.getState().setSyncProgress(progress);
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onOfflineOperationsDropped(({ accountId }) => {
        if (accountId !== useAppStore.getState().activeAccountId) return;
        setError(strings.mail.offlineChangesDropped);
        void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    const refreshLocal = (event: Event) => {
      const accountId = (event as CustomEvent<string>).detail;
      if (accountId === useAppStore.getState().activeAccountId)
        void loadersRef.current.loadAccountData();
    };
    window.addEventListener("postal:local-mail-changed", refreshLocal);
    return () => {
      active = false;
      unsubs.forEach((fn) => fn());
      window.removeEventListener("postal:local-mail-changed", refreshLocal);
    };
  }, [loadAccountCounts, loadersRef, setError, submittedQueryRef]);
}
