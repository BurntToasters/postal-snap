import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { accountCannotSend } from "../accountStatus";
import { holdBackgroundUpdate } from "../update";
import { useAppStore } from "../store";
import type { OutboxSummary, SyncState } from "../types";
import { errorText } from "../errors";

// Browsers overflow setTimeout delays above ~24.8 days, so re-check hourly.
const MAX_TIMER_MS = 60 * 60 * 1000;
const SCHEDULED_RETRY_COOLDOWN_MS = 30_000;

export function useScheduledOutbox(
  activeAccountId: string | undefined,
  outbox: OutboxSummary[],
  sync: SyncState | undefined,
  loadAccountData: () => Promise<void>,
  setError: (error: string) => void,
) {
  const scheduledOutboxInFlight = useRef(new Set<string>());
  const retryCooldownUntil = useRef(new Map<string, number>());
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
    return api
      .sendScheduledOutbox(id, accountId)
      .then(
        (outcome) => {
          if (outcome.state === "scheduled") {
            retryCooldownUntil.current.set(
              key,
              Date.now() + SCHEDULED_RETRY_COOLDOWN_MS,
            );
            setScheduleTick((tick) => tick + 1);
          } else {
            retryCooldownUntil.current.delete(key);
          }
          return outcome;
        },
        (cause) => {
          retryCooldownUntil.current.set(
            key,
            Date.now() + SCHEDULED_RETRY_COOLDOWN_MS,
          );
          setScheduleTick((tick) => tick + 1);
          throw cause;
        },
      )
      .finally(() => {
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
      retryCooldownUntil.current.delete(`${activeAccountId}:${id}`);
      try {
        const request = beginScheduledSend(id, activeAccountId);
        if (!request) return;
        const outcome = await request;
        if (outcome.state !== "sent" && outcome.detail) {
          setError(outcome.detail);
        }
        await loadAccountData();
      } catch (cause) {
        setError(errorText(cause));
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
    const now = Date.now();
    const activeScheduledKeys = new Set(
      outbox
        .filter(
          (item) =>
            item.accountId === activeAccountId &&
            item.state === "scheduled" &&
            item.sendAt,
        )
        .map((item) => `${item.accountId}:${item.id}`),
    );
    for (const [key, until] of retryCooldownUntil.current) {
      if (
        until <= now ||
        (activeAccountId &&
          key.startsWith(`${activeAccountId}:`) &&
          !activeScheduledKeys.has(key))
      ) {
        retryCooldownUntil.current.delete(key);
      }
    }
    const due = outbox
      .filter(
        (item) =>
          item.accountId === activeAccountId &&
          item.state === "scheduled" &&
          item.sendAt,
      )
      .map((item) => {
        const sendMs = new Date(item.sendAt as string).getTime();
        if (!Number.isFinite(sendMs)) return Number.NaN;
        const cooldown =
          retryCooldownUntil.current.get(`${item.accountId}:${item.id}`) ?? 0;
        return Math.max(sendMs, cooldown) - now;
      })
      .filter((ms) => Number.isFinite(ms));
    if (due.length === 0 || !activeAccountId) return;
    const wait = Math.min(...due);
    if (wait <= 0) {
      const overdue = outbox.find(
        (item) =>
          item.accountId === activeAccountId &&
          item.state === "scheduled" &&
          item.sendAt &&
          new Date(item.sendAt).getTime() <= now &&
          (retryCooldownUntil.current.get(`${item.accountId}:${item.id}`) ??
            0) <= now,
      );
      if (overdue && activeAccountId) {
        const id = overdue.id;
        const account = activeAccountId;
        const request = beginScheduledSend(id, account);
        if (request)
          void request
            .then((outcome) => {
              if (outcome && outcome.state !== "sent" && outcome.detail) {
                setError(outcome.detail);
              }
            })
            .catch((cause) => setError(errorText(cause)))
            .finally(() => void loadAccountData());
      }
      return;
    }
    const timer = window.setTimeout(
      () => {
        const current = useAppStore.getState();
        const firedAt = Date.now();
        const ready = current.outbox.find(
          (item) =>
            item.state === "scheduled" &&
            item.accountId === current.activeAccountId &&
            item.sendAt &&
            new Date(item.sendAt).getTime() <= firedAt &&
            (retryCooldownUntil.current.get(`${item.accountId}:${item.id}`) ??
              0) <= firedAt,
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
              .then((outcome) => {
                if (outcome && outcome.state !== "sent" && outcome.detail) {
                  setError(outcome.detail);
                }
              })
              .catch((cause) => setError(errorText(cause)))
              .finally(() => void loadAccountData());
        } else {
          const stillScheduled = current.outbox.some(
            (item) =>
              item.state === "scheduled" &&
              item.accountId === current.activeAccountId &&
              item.sendAt &&
              Number.isFinite(new Date(item.sendAt).getTime()),
          );
          // The clamp or cooldown ended before send readiness: re-arm only.
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

  const isScheduledSendInFlight = useCallback(
    (id: string, accountId: string) =>
      scheduledOutboxInFlight.current.has(`${accountId}:${id}`),
    [],
  );

  return {
    scheduledSendInFlight,
    isScheduledSendInFlight,
    beginScheduledSend,
    sendScheduledNow,
  };
}
