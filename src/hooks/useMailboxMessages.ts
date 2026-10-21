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
import type { MessageCursor } from "../types";
import { mergeSearchResults } from "../components/mail/mailSearch";

interface Options {
  listFilter: MessageListFilter;
  listSort: MessageListSort;
  submittedQuery: string;
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
  submittedQuery,
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

  const loadMessages = useCallback(async () => {
    if (
      !activeAccountId ||
      !activeMailboxId ||
      activeLocalView ||
      submittedQueryRef.current
    ) {
      messageRequestRef.current += 1;
      setLoadingMessages(false);
      return;
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
        return;
      setMessages(loaded.items, loaded.nextCursor ?? undefined, loaded.hasMore);
    } catch (cause) {
      if (request === messageRequestRef.current) setError(String(cause));
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
      if (request === pagingRequestRef.current) setError(String(cause));
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
      if (request === pagingRequestRef.current) setError(String(cause));
    } finally {
      if (request === pagingRequestRef.current) setLoadingMessages(false);
    }
  }

  const searchStillCurrent = useCallback(
    (
      request: number,
      accountId: string,
      mailboxId?: number,
      text?: string,
      searchAllFolders?: boolean,
    ) => {
      const current = useAppStore.getState();
      return (
        request === searchRequestRef.current &&
        current.activeAccountId === accountId &&
        current.activeMailboxId === mailboxId &&
        !current.activeLocalView &&
        (text === undefined || queryRef.current.trim() === text) &&
        (searchAllFolders === undefined ||
          allFoldersRef.current === searchAllFolders)
      );
    },
    [searchRequestRef, queryRef, allFoldersRef],
  );

  const runSearch = useCallback(async () => {
    const viewing = useAppStore.getState();
    if (!viewing.activeAccountId || viewing.activeLocalView) return;
    const text = queryRef.current.trim();
    const searchAllFolders = allFoldersRef.current;
    const request = ++searchRequestRef.current;
    messageRequestRef.current += 1;
    pagingRequestRef.current += 1;
    if (!text) {
      submittedQueryRef.current = "";
      setSubmittedQuery("");
      await loadMessages();
      return;
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
    const mailboxId = viewing.activeMailboxId;
    const search = {
      accountId,
      mailboxId,
      text,
      allFolders: searchAllFolders,
      limit: 250,
    };
    setLoadingMessages(true);
    try {
      const cached = await api.searchCached(search);
      if (
        searchStillCurrent(
          request,
          accountId,
          mailboxId,
          search.text,
          search.allFolders,
        )
      )
        setMessages(cached, undefined, false);
      const server = await api.searchServer(search);
      if (
        searchStillCurrent(
          request,
          accountId,
          mailboxId,
          search.text,
          search.allFolders,
        )
      )
        setMessages(mergeSearchResults(cached, server), undefined, false);
    } catch (cause) {
      if (
        searchStillCurrent(
          request,
          accountId,
          mailboxId,
          search.text,
          search.allFolders,
        )
      )
        setError(strings.mail.partialSearch(String(cause)));
    } finally {
      if (request === searchRequestRef.current) setLoadingMessages(false);
    }
  }, [
    loadMessages,
    setError,
    setMessages,
    queryRef,
    allFoldersRef,
    searchRequestRef,
    messageRequestRef,
    pagingRequestRef,
    submittedQueryRef,
    setSubmittedQuery,
    setRecentByAccount,
    searchStillCurrent,
  ]);

  return {
    loadMessages,
    loadMoreMessages,
    runSearch,
    canDownloadOlder,
    loadingMessages,
  };
}
