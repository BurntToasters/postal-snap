import { useEffect, useRef } from "react";
import { api } from "../../api";
import { errorText } from "../../errors";
import { useAppStore } from "../../store";
import type { MessageSummary } from "../../types";

const MAILBOX_WAIT_MS = 10_000;

interface Options {
  openFoundMessage: (accountId: string, found: MessageSummary) => Promise<void>;
  setError: (error?: string) => void;
}

// Resolves once accountId has mailboxes, or after a timeout.
function waitForMailboxes(accountId: string): Promise<void> {
  const ready = () => {
    const state = useAppStore.getState();
    return (
      state.activeAccountId !== accountId || state.activeMailboxId !== undefined
    );
  };
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      unsubscribe();
      window.clearTimeout(timer);
      resolve();
    };
    const unsubscribe = useAppStore.subscribe(() => {
      if (ready()) done();
    });
    const timer = window.setTimeout(done, MAILBOX_WAIT_MS);
  });
}

/** Opens the message named by a desktop notification click. */
export function useNotificationOpen({ openFoundMessage, setError }: Options) {
  const latest = useRef({ openFoundMessage, setError });
  useEffect(() => {
    latest.current = { openFoundMessage, setError };
  });

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const knownAccount = (accountId: string) =>
      useAppStore.getState().accounts.some((item) => item.id === accountId);

    async function open(accountId: string, messageId: number) {
      if (!knownAccount(accountId)) return;
      try {
        const state = useAppStore.getState();
        const loaded =
          state.activeAccountId === accountId
            ? state.messages.find((item) => item.id === messageId)
            : undefined;
        const found = loaded ?? (await api.getMessage(accountId, messageId));
        if (!active || !knownAccount(accountId)) return;
        if (useAppStore.getState().activeAccountId !== accountId) {
          useAppStore.getState().selectAccount(accountId);
          await waitForMailboxes(accountId);
          if (!active || useAppStore.getState().activeAccountId !== accountId)
            return;
        }
        await latest.current.openFoundMessage(accountId, found);
      } catch (cause) {
        if (active) latest.current.setError(errorText(cause));
      }
    }

    void api
      .onNotificationOpen(({ accountId, messageId }) => {
        void open(accountId, messageId);
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
}
