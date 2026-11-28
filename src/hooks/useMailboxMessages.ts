import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { api } from "../api";
import { strings } from "../i18n";
import type { MessageListFilter } from "../listFilter";
import type { MessageListSort } from "../listSort";
import { useAppStore } from "../store";
import type { MessageCursor, SearchQuery, ServerSearchResult } from "../types";
import {
  appendServerSearchResults,
  mergeSearchResults,
} from "../components/mail/mailSearch";
import { errorText } from "../errors";

/** A server search that stopped early. The resume id is null when it cannot continue. */
interface ServerSearchMore {
  accountId: string;
  mailboxId?: number;
  text: string;
  allFolders: boolean;
  partial: boolean;
  resumeAfterMailboxId: number | null;
}

function serverSearchMoreFor(
  server: ServerSearchResult,
  base: Omit<ServerSearchMore, "partial" | "resumeAfterMailboxId">,
  partialBeforePage = false,
): ServerSearchMore | null {
  const partial = partialBeforePage || server.partial === true;
  if (server.complete && !partial) return null;
  return {
    ...base,
    partial,
    resumeAfterMailboxId: server.complete
      ? null
      : (server.resumeAfterMailboxId ?? null),
  };
}

interface Options {
  listFilter: MessageListFilter;
  listSort: MessageListSort;
  query: string;
  submittedQuery: string;
  allFolders: boolean;
  setSubmittedQuery: Dispatch<SetStateAction<string>>;
  setRecentByAccount: Dispatch<SetStateAction<Record<string, string[]>>>;
  messageRequestRef: RefObject<number>;
  pagingRequestRef: RefObject<number>;
  searchRequestRef: RefObject<number>;
  queryRef: RefObject<string>;
  submittedQueryRef: RefObject<string>;
  allFoldersRef: RefObject<boolean>;
}

export function useMailboxMessages({
  listFilter,
  listSort,
  query,
  submittedQuery,
  allFolders,
  setSubmittedQuery,
  setRecentByAccount,
  messageRequestRef,
  pagingRequestRef,
  searchRequestRef,
  queryRef,
  submittedQueryRef,
  allFoldersRef,
}: Options) {
  const activeAccountId = useAppStore((state) => state.activeAccountId);
  const activeMailboxId = useAppStore((state) => state.activeMailboxId);
  const activeLocalView = useAppStore((state) => state.activeLocalView);
  const messages = useAppStore((state) => state.messages);
  const messageCursor = useAppStore((state) => state.messageCursor);
  const hasMoreMessages = useAppStore((state) => state.hasMoreMessages);
  const setMessages = useAppStore((state) => state.setMessages);
  const appendMessages = useAppStore((state) => state.appendMessages);
  const setError = useAppStore((state) => state.setError);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [serverSearchMoreState, setServerSearchMore] =
    useState<ServerSearchMore | null>(null);

  // The worker polls the open folder more often; tell it which one is open.
  useEffect(() => {
    if (!activeAccountId) return;
    const mailboxId =
      activeLocalView || !activeMailboxId ? null : activeMailboxId;
    void Promise.resolve()
      .then(() => api.setVisibleFolder(activeAccountId, mailboxId))
      .catch(() => undefined);
  }, [activeAccountId, activeLocalView, activeMailboxId]);

  const listMailboxPage = useCallback(
    (accountId: string, mailboxId: number, cursor?: MessageCursor) => {
      if (listFilter === "all" && listSort === "date") {
        return cursor
          ? api.listMessages(accountId, mailboxId, cursor)
          : api.listMessages(accountId, mailboxId);
      }
      if (listSort === "date") {
        return api.listMessages(accountId, mailboxId, cursor, 100, listFilter);
      }
      return api.listMessages(
        accountId,
        mailboxId,
        cursor,
        100,
        listFilter === "all" ? undefined : listFilter,
        listSort,
      );
    },
    [listFilter, listSort],
  );

  const loadMessages = useCallback(async (): Promise<boolean> => {
    if (
      !activeAccountId ||
      !activeMailboxId ||
      activeLocalView ||
      submittedQueryRef.current
    ) {
      messageRequestRef.current += 1;
      if (!submittedQueryRef.current) setLoadingMessages(false);
      return false;
    }
    const accountId = activeAccountId;
    const mailboxId = activeMailboxId;
    const request = ++messageRequestRef.current;
    pagingRequestRef.current += 1;
    searchRequestRef.current += 1;
    setLoadingMessages(true);
    try {
      const loaded = await listMailboxPage(accountId, mailboxId);
      const current = useAppStore.getState();
      if (
        request !== messageRequestRef.current ||
        current.activeAccountId !== accountId ||
        current.activeMailboxId !== mailboxId ||
        current.activeLocalView
      )
        return false;
      setMessages(loaded.items, loaded.nextCursor ?? undefined, loaded.hasMore);
      return true;
    } catch (cause) {
      if (request === messageRequestRef.current) setError(errorText(cause));
      return false;
    } finally {
      if (request === messageRequestRef.current) setLoadingMessages(false);
    }
  }, [
    activeAccountId,
    activeLocalView,
    activeMailboxId,
    listMailboxPage,
    messageRequestRef,
    pagingRequestRef,
    searchRequestRef,
    submittedQueryRef,
    setError,
    setMessages,
  ]);

  // Mailboxes whose server history is fully downloaded this session.
  const [serverHistoryDone, setServerHistoryDone] = useState<number[]>([]);
  const canDownloadOlder =
    !hasMoreMessages &&
    Boolean(activeMailboxId) &&
    !activeLocalView &&
    !submittedQuery &&
    messages.length > 0 &&
    !serverHistoryDone.includes(activeMailboxId ?? -1);

  /** The cache is exhausted: fetch one older batch from the server. */
  async function downloadOlderMessages() {
    if (!activeAccountId || !activeMailboxId || loadingMessages) return;
    const accountId = activeAccountId;
    const mailboxId = activeMailboxId;
    const request = ++pagingRequestRef.current;
    setLoadingMessages(true);
    try {
      const outcome = await api.loadOlderMessages(accountId, mailboxId);
      if (!outcome.hasMore)
        setServerHistoryDone((done) => [...done, mailboxId]);
      const current = useAppStore.getState();
      if (
        outcome.added === 0 ||
        request !== pagingRequestRef.current ||
        current.activeAccountId !== accountId ||
        current.activeMailboxId !== mailboxId ||
        current.activeLocalView ||
        submittedQueryRef.current
      )
        return;
      const last = current.messages[current.messages.length - 1];
      if (listSort !== "date" || !last) {
        // Older mail lands inside other orders; reload from the top.
        await loadMessages();
        return;
      }
      const page = await listMailboxPage(accountId, mailboxId, {
        receivedAt: last.receivedAt,
        uid: last.uid,
        sort: "date",
        key: "",
        pinned: last.pinned,
      });
      if (request === pagingRequestRef.current)
        appendMessages(page.items, page.nextCursor ?? undefined, page.hasMore);
    } catch (cause) {
      if (request === pagingRequestRef.current) setError(errorText(cause));
    } finally {
      if (request === pagingRequestRef.current) setLoadingMessages(false);
    }
  }

  async function loadMoreMessages() {
    if (!hasMoreMessages && canDownloadOlder) {
      await downloadOlderMessages();
      return;
    }
    if (
      !activeAccountId ||
      !activeMailboxId ||
      activeLocalView ||
      !messageCursor ||
      loadingMessages
    )
      return;
    const accountId = activeAccountId;
    const mailboxId = activeMailboxId;
    const request = ++pagingRequestRef.current;
    setLoadingMessages(true);
    try {
      const page = await listMailboxPage(accountId, mailboxId, messageCursor);
      const current = useAppStore.getState();
      if (
        request === pagingRequestRef.current &&
        current.activeAccountId === accountId &&
        current.activeMailboxId === mailboxId &&
        !current.activeLocalView &&
        !submittedQueryRef.current
      )
        appendMessages(page.items, page.nextCursor ?? undefined, page.hasMore);
    } catch (cause) {
      if (request === pagingRequestRef.current) setError(errorText(cause));
    } finally {
      if (request === pagingRequestRef.current) setLoadingMessages(false);
    }
  }

  const searchStillCurrent = useCallback(
    (
      request: number,
      accountId: string,
      mailboxId: number | undefined,
      text: string,
      searchAllFolders: boolean,
      requireLiveQuery: boolean,
    ) => {
      const current = useAppStore.getState();
      return (
        request === searchRequestRef.current &&
        current.activeAccountId === accountId &&
        current.activeMailboxId === mailboxId &&
        !current.activeLocalView &&
        submittedQueryRef.current === text &&
        (!requireLiveQuery || queryRef.current.trim() === text) &&
        allFoldersRef.current === searchAllFolders
      );
    },
    [searchRequestRef, queryRef, allFoldersRef, submittedQueryRef],
  );

  const refreshSearch = useCallback(
    async (
      text: string,
      searchAllFolders: boolean,
      requireLiveQuery: boolean,
    ): Promise<boolean> => {
      const viewing = useAppStore.getState();
      if (!viewing.activeAccountId || viewing.activeLocalView) return false;
      const accountId = viewing.activeAccountId;
      const mailboxId = viewing.activeMailboxId;
      const request = ++searchRequestRef.current;
      messageRequestRef.current += 1;
      pagingRequestRef.current += 1;
      const search = {
        accountId,
        mailboxId,
        text,
        allFolders: searchAllFolders,
        limit: 250,
      };
      setServerSearchMore(null);
      setLoadingMessages(true);
      let applied = false;
      try {
        const cached = await api.searchCached(search);
        if (
          searchStillCurrent(
            request,
            accountId,
            mailboxId,
            text,
            searchAllFolders,
            requireLiveQuery,
          )
        )
          setMessages(cached, undefined, false);
        const server = await api.searchServer(search);
        if (
          searchStillCurrent(
            request,
            accountId,
            mailboxId,
            text,
            searchAllFolders,
            requireLiveQuery,
          )
        ) {
          setMessages(
            mergeSearchResults(cached, server.messages),
            undefined,
            false,
          );
          setServerSearchMore(
            serverSearchMoreFor(server, {
              accountId,
              mailboxId,
              text,
              allFolders: searchAllFolders,
            }),
          );
          applied = true;
        }
      } catch (cause) {
        if (
          searchStillCurrent(
            request,
            accountId,
            mailboxId,
            text,
            searchAllFolders,
            requireLiveQuery,
          )
        )
          setError(strings.mail.partialSearch(errorText(cause)));
        return false;
      } finally {
        if (request === searchRequestRef.current) setLoadingMessages(false);
      }
      return applied;
    },
    [
      searchRequestRef,
      messageRequestRef,
      pagingRequestRef,
      setMessages,
      setError,
      setServerSearchMore,
      searchStillCurrent,
    ],
  );

  const runSearch = useCallback(async (): Promise<boolean> => {
    const viewing = useAppStore.getState();
    if (!viewing.activeAccountId || viewing.activeLocalView) return false;
    const text = queryRef.current.trim();
    const searchAllFolders = allFoldersRef.current;
    if (!text) {
      submittedQueryRef.current = "";
      setSubmittedQuery("");
      return loadMessages();
    }
    submittedQueryRef.current = text;
    setSubmittedQuery(text);
    const accountId = viewing.activeAccountId;
    void api.rememberSearch(accountId, text).then(
      (queries) => {
        setRecentByAccount((current) => ({
          ...current,
          [accountId]: queries,
        }));
      },
      () => undefined,
    );
    return refreshSearch(text, searchAllFolders, true);
  }, [
    loadMessages,
    queryRef,
    allFoldersRef,
    submittedQueryRef,
    setSubmittedQuery,
    setRecentByAccount,
    refreshSearch,
  ]);

  const refreshSubmittedSearch = useCallback(async (): Promise<boolean> => {
    const viewing = useAppStore.getState();
    if (!viewing.activeAccountId || viewing.activeLocalView) return false;
    const text = submittedQueryRef.current;
    if (!text) return loadMessages();
    return refreshSearch(text, allFoldersRef.current, false);
  }, [loadMessages, submittedQueryRef, allFoldersRef, refreshSearch]);

  // Shown only while the same search is still on screen.
  const serverSearchMore =
    serverSearchMoreState &&
    serverSearchMoreState.accountId === activeAccountId &&
    serverSearchMoreState.mailboxId === activeMailboxId &&
    serverSearchMoreState.text === submittedQuery &&
    serverSearchMoreState.text === query.trim() &&
    serverSearchMoreState.allFolders === allFolders &&
    !activeLocalView
      ? serverSearchMoreState
      : null;

  /** Continues a stopped all-folder search after the last finished folder. */
  const searchMoreFolders = useCallback(async () => {
    const more = serverSearchMore;
    const resume = more?.resumeAfterMailboxId;
    const current = useAppStore.getState();
    if (
      !more ||
      resume == null ||
      loadingMessages ||
      current.activeAccountId !== more.accountId ||
      current.activeMailboxId !== more.mailboxId ||
      current.activeLocalView ||
      submittedQueryRef.current !== more.text ||
      queryRef.current.trim() !== more.text ||
      allFoldersRef.current !== more.allFolders
    )
      return;
    const request = ++searchRequestRef.current;
    setLoadingMessages(true);
    try {
      const server = await api.searchServer({
        accountId: more.accountId,
        mailboxId: more.mailboxId,
        text: more.text,
        allFolders: more.allFolders,
        limit: 250,
        resumeAfterMailboxId: resume,
      } satisfies SearchQuery);
      if (
        searchStillCurrent(
          request,
          more.accountId,
          more.mailboxId,
          more.text,
          more.allFolders,
          true,
        )
      ) {
        setMessages(
          appendServerSearchResults(
            useAppStore.getState().messages,
            server.messages,
          ),
          undefined,
          false,
        );
        setServerSearchMore(
          serverSearchMoreFor(
            server,
            {
              accountId: more.accountId,
              mailboxId: more.mailboxId,
              text: more.text,
              allFolders: more.allFolders,
            },
            more.partial,
          ),
        );
      }
    } catch (cause) {
      if (
        searchStillCurrent(
          request,
          more.accountId,
          more.mailboxId,
          more.text,
          more.allFolders,
          true,
        )
      )
        setError(strings.mail.partialSearch(errorText(cause)));
    } finally {
      if (request === searchRequestRef.current) setLoadingMessages(false);
    }
  }, [
    serverSearchMore,
    loadingMessages,
    searchRequestRef,
    queryRef,
    allFoldersRef,
    submittedQueryRef,
    searchStillCurrent,
    setError,
    setMessages,
  ]);

  return {
    loadMessages,
    loadMoreMessages,
    runSearch,
    refreshSubmittedSearch,
    canDownloadOlder,
    loadingMessages,
    serverSearchMore,
    searchMoreFolders,
  };
}
