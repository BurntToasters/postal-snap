import { useEffect, useMemo, type MutableRefObject } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";

type AppState = ReturnType<typeof useAppStore.getState>;

// A burst of events runs once, 150 ms after its last event.
const COALESCE_MS = 150;
// A steady stream still runs at least every 500 ms.
const MAX_WAIT_MS = 500;

interface Work {
  /** Mailbox counts only (`listMailboxes`). */
  counts: boolean;
  /** Mailboxes, drafts, outbox and snoozed. */
  data: boolean;
  messages: boolean;
}

interface Options {
  loadAccountCounts: () => Promise<void>;
  loadersRef: MutableRefObject<{
    loadAccountData: () => Promise<void>;
    loadMailboxCounts: () => Promise<void>;
    loadMessages: () => Promise<void>;
    runSearch: () => Promise<void>;
  }>;
  submittedQueryRef: MutableRefObject<string>;
  setError: AppState["setError"];
}

function coalesce(run: () => void) {
  let timer: number | undefined;
  let startedAt = 0;
  return {
    request() {
      const now = Date.now();
      if (timer === undefined) startedAt = now;
      window.clearTimeout(timer);
      const wait = Math.min(COALESCE_MS, startedAt + MAX_WAIT_MS - now);
      timer = window.setTimeout(
        () => {
          timer = undefined;
          run();
        },
        Math.max(0, wait),
      );
    },
    cancel() {
      window.clearTimeout(timer);
      timer = undefined;
    },
  };
}

function createQueues(
  loadAccountCounts: () => Promise<void>,
  loadersRef: Options["loadersRef"],
  submittedQueryRef: Options["submittedQueryRef"],
) {
  const work: Work = { counts: false, data: false, messages: false };
  const account = coalesce(() => {
    const due = { ...work };
    work.counts = false;
    work.data = false;
    work.messages = false;
    const loaders = loadersRef.current;
    if (due.data) void loaders.loadAccountData();
    else if (due.counts) void loaders.loadMailboxCounts();
    if (due.messages) {
      if (submittedQueryRef.current) void loaders.runSearch();
      else void loaders.loadMessages();
    }
  });
  const badges = coalesce(() => void loadAccountCounts());
  // Drops pending account work, e.g. when the active account changes.
  const cancelAccount = () => {
    account.cancel();
    work.counts = false;
    work.data = false;
    work.messages = false;
  };
  return {
    markAccount(flags: Partial<Work>) {
      Object.assign(work, flags);
      account.request();
    },
    requestBadges: () => badges.request(),
    cancelAccount,
    cancelAll() {
      cancelAccount();
      badges.cancel();
    },
  };
}

export function useMailEvents({
  loadAccountCounts,
  loadersRef,
  submittedQueryRef,
  setError,
}: Options) {
  const activeAccountId = useAppStore((state) => state.activeAccountId);
  const queues = useMemo(
    () => createQueues(loadAccountCounts, loadersRef, submittedQueryRef),
    [loadAccountCounts, loadersRef, submittedQueryRef],
  );

  useEffect(() => () => queues.cancelAccount(), [activeAccountId, queues]);
  useEffect(() => () => queues.cancelAll(), [queues]);

  useEffect(() => {
    let active = true;
    const unsubs: Array<() => void> = [];
    const track = (promise: Promise<() => void>) => {
      void promise.then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    };
    track(
      api.onFolderCountsChanged(({ accountId }) => {
        queues.requestBadges();
        if (accountId === useAppStore.getState().activeAccountId)
          queues.markAccount({ counts: true });
      }),
    );
    track(
      api.onMessageChanged(({ accountId, messageId, kind }) => {
        const store = useAppStore.getState();
        if (accountId !== store.activeAccountId) return;
        queues.markAccount({ messages: true });
        if (
          messageId &&
          store.selectedMessage?.id === messageId &&
          kind === "moved"
        ) {
          store.selectMessage(undefined);
        }
      }),
    );
    track(
      api.onDraftSyncChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          queues.markAccount({ data: true });
      }),
    );
    track(
      api.onOutboxChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          queues.markAccount({ data: true });
      }),
    );
    track(
      api.onSyncProgress((progress) => {
        if (progress.accountId === useAppStore.getState().activeAccountId)
          useAppStore.getState().setSyncProgress(progress);
      }),
    );
    track(
      api.onOfflineOperationsDropped(({ accountId }) => {
        if (accountId !== useAppStore.getState().activeAccountId) return;
        setError(strings.mail.offlineChangesDropped);
        queues.markAccount({ data: true });
      }),
    );
    const refreshLocal = (event: Event) => {
      const accountId = (event as CustomEvent<string>).detail;
      if (accountId === useAppStore.getState().activeAccountId)
        queues.markAccount({ data: true });
    };
    window.addEventListener("postal:local-mail-changed", refreshLocal);
    return () => {
      active = false;
      unsubs.forEach((fn) => fn());
      window.removeEventListener("postal:local-mail-changed", refreshLocal);
    };
  }, [queues, setError]);
}
