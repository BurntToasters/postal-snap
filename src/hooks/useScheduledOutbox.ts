import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { accountCannotSend } from "../accountStatus";
import { holdBackgroundUpdate } from "../update";
import { useAppStore } from "../store";
import type { OutboxSummary, SyncState } from "../types";

// Browsers overflow setTimeout delays above ~24.8 days, so re-check hourly.
const MAX_TIMER_MS = 60 * 60 * 1000;

export function useScheduledOutbox(
  activeAccountId: string | undefined,
  outbox: OutboxSummary[],
  sync: SyncState | undefined,
  loadAccountData: () => Promise<void>,
  setError: (error: string) => void,
) {
  const scheduledOutboxInFlight = useRef(new Set<string>());
  // Bumped to re-arm a clamped timer without an IPC reload.
  const [scheduleTick, setScheduleTick] = useState(0);
  const [scheduledSendInFlight, setScheduledSendInFlight] = useState<
    Set<string>
  >(() => new Set());

  const beginScheduledSend = useCallback((id: string, accountId: string) => {
    const key = `${accountId}:${id}`;
    if (scheduledOutboxInFlight.current.has(key)) return undefined;
    scheduledOutboxInFlight.current.add(key);
    setScheduledSendInFlight((previous) => new Set(previous).add(key));
    // An update restart mid-send would leave the SMTP outcome uncertain.
    const releaseUpdateHold = holdBackgroundUpdate();
    return api.sendScheduledOutbox(id, accountId).finally(() => {
      releaseUpdateHold();
      scheduledOutboxInFlight.current.delete(key);
      setScheduledSendInFlight((previous) => {
        if (!previous.has(key)) return previous;
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    });
  }, []);

  const sendScheduledNow = useCallback(
    async (id: string) => {
      if (!activeAccountId) return;
      try {
        const request = beginScheduledSend(id, activeAccountId);
        if (!request) return;
        const outcome = await request;
        if (outcome.state !== "sent" && outcome.detail) {
          setError(outcome.detail);
        }
        await loadAccountData();
      } catch (cause) {
        setError(String(cause));
        await loadAccountData();
      }
    },
    [activeAccountId, beginScheduledSend, loadAccountData, setError],
  );

  useEffect(() => {
    const currentStore = useAppStore.getState();
    const account = currentStore.accounts.find(
      (item) => item.id === activeAccountId,
    );
    if (accountCannotSend(account, sync)) return;
    const due = outbox
      .filter(
        (item) =>
          item.accountId === activeAccountId &&
          item.state === "scheduled" &&
          item.sendAt,
      )
      .map((item) => new Date(item.sendAt as string).getTime() - Date.now())
      .filter((ms) => Number.isFinite(ms));
    if (due.length === 0 || !activeAccountId) return;
    const wait = Math.min(...due);
    if (wait <= 0) {
      const overdue = outbox.find(
        (item) =>
          item.accountId === activeAccountId &&
          item.state === "scheduled" &&
          item.sendAt &&
          new Date(item.sendAt).getTime() <= Date.now(),
      );
      if (overdue && activeAccountId) {
        const id = overdue.id;
        const account = activeAccountId;
        const request = beginScheduledSend(id, account);
        if (request)
          void request
            .catch((cause) => setError(String(cause)))
            .finally(() => void loadAccountData());
      }
      return;
    }
    const timer = window.setTimeout(
      () => {
        const current = useAppStore.getState();
        const ready = current.outbox.find(
          (item) =>
            item.state === "scheduled" &&
            item.accountId === current.activeAccountId &&
            item.sendAt &&
            new Date(item.sendAt).getTime() <= Date.now(),
        );
        const currentAccount = current.accounts.find(
          (item) => item.id === current.activeAccountId,
        );
        const liveSync = current.activeAccountId
          ? current.sync[current.activeAccountId]
          : undefined;
        if (
          ready &&
          current.activeAccountId &&
          !accountCannotSend(currentAccount, liveSync)
        ) {
          const request = beginScheduledSend(ready.id, current.activeAccountId);
          if (request)
            void request
              .catch((cause) => setError(String(cause)))
              .finally(() => void loadAccountData());
        } else {
          const stillScheduled = current.outbox.some(
            (item) =>
              item.state === "scheduled" &&
              item.accountId === current.activeAccountId &&
              item.sendAt &&
              new Date(item.sendAt).getTime() > Date.now(),
          );
          // The clamp period ended before the send time: re-arm only.
          if (stillScheduled) setScheduleTick((tick) => tick + 1);
          else void loadAccountData();
        }
      },
      Math.min(wait, MAX_TIMER_MS),
    );
    return () => window.clearTimeout(timer);
  }, [
    outbox,
    activeAccountId,
    sync,
    scheduleTick,
    beginScheduledSend,
    loadAccountData,
    setError,
  ]);

  return {
    scheduledSendInFlight,
    beginScheduledSend,
    sendScheduledNow,
  };
}
