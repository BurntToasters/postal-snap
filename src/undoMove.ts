import { api } from "./api";
import { strings } from "./i18n";
import { folderLabel } from "./i18n/mail";
import {
  DEFAULT_NOTICE_TIMEOUT_MS,
  UNDO_NOTICE_MAX_MS,
  type NoticeEndReason,
} from "./notices";
import { useAppStore } from "./store";
import type { MailboxSummary } from "./types";

// One fixed id: a newer move replaces this notice, which commits the older move.
export const UNDO_MOVE_NOTICE_ID = "undo-move";
const UNDO_ACTION_ID = "undo";
let undoSessionPromise: Promise<string> | undefined;

/** Initialize once per frontend instance; clear rejection so a reload retry works. */
export function ensureUndoSession(): Promise<string> {
  if (!undoSessionPromise) {
    const started = api.beginUndoSession().then((session) => {
      if (!/^[a-f0-9]{32}$/.test(session)) {
        throw new Error("The undo session could not be started.");
      }
      return session;
    });
    undoSessionPromise = started.catch((cause: unknown) => {
      undoSessionPromise = undefined;
      throw cause;
    });
  }
  return undoSessionPromise;
}

export type UndoMoveTarget =
  { kind: "archive" | "trash" | "junk" } | { kind: "folder"; name: string };

export function undoTargetFor(mailbox: MailboxSummary): UndoMoveTarget {
  if (
    mailbox.role === "archive" ||
    mailbox.role === "trash" ||
    mailbox.role === "junk"
  ) {
    return { kind: mailbox.role };
  }
  return { kind: "folder", name: folderLabel(mailbox) };
}

interface UndoableMove<T> {
  accountId: string;
  target: UndoMoveTarget;
  /** Sends the move with its undo token, so the backend defers it. */
  send: (undoToken: string) => Promise<T>;
  /** Messages the call left inside the undo window. */
  deferred: (result: T) => number;
}

/**
 * Runs a user-initiated move behind an undo window. Errors from the move
 * itself are thrown to the caller, as before.
 */
export async function undoableMove<T>(move: UndoableMove<T>): Promise<T> {
  const session = await ensureUndoSession();
  const undoToken = `${session}${crypto.randomUUID().replaceAll("-", "")}`;
  const result = await move.send(undoToken);
  const count = move.deferred(result);
  if (count > 0) offerUndo(move.accountId, undoToken, count, move.target);
  return result;
}

function offerUndo(
  accountId: string,
  undoToken: string,
  count: number,
  target: UndoMoveTarget,
) {
  useAppStore.getState().pushNotice({
    id: UNDO_MOVE_NOTICE_ID,
    severity: "info",
    message: movedMessage(count, target),
    timeoutMs: DEFAULT_NOTICE_TIMEOUT_MS,
    // A paused notice may not outlive the backend's 60-second hold.
    maxVisibleMs: UNDO_NOTICE_MAX_MS,
    actions: [
      {
        id: UNDO_ACTION_ID,
        label: strings.notices.undo,
        // Dismissing runs onEnd("action"), which performs the undo once.
        run: () =>
          useAppStore.getState().dismissNotice(UNDO_MOVE_NOTICE_ID, "action"),
      },
    ],
    onEnd: (reason) => void settleUndo(accountId, undoToken, count, reason),
  });
}

function movedMessage(count: number, target: UndoMoveTarget): string {
  switch (target.kind) {
    case "archive":
      return strings.notices.archived(count);
    case "trash":
      return strings.notices.trashed(count);
    case "junk":
      return strings.notices.junked(count);
    case "folder":
      return strings.notices.movedTo(count, target.name);
  }
}

// Commits the move unless Undo ended the notice. Commit runs exactly once.
async function settleUndo(
  accountId: string,
  undoToken: string,
  count: number,
  reason: NoticeEndReason,
) {
  if (reason !== "action") {
    try {
      await api.commitDeferred(accountId, undoToken);
    } catch (cause) {
      useAppStore.getState().setError(String(cause));
    }
    return;
  }
  try {
    const outcome = await api.undoDeferred(accountId, undoToken);
    useAppStore.getState().pushNotice({
      severity: "info",
      message: undoneMessage(outcome.restored, count),
      timeoutMs: DEFAULT_NOTICE_TIMEOUT_MS,
    });
  } catch (cause) {
    useAppStore.getState().setError(String(cause));
  }
}

// Nothing restored means the window had already closed on the server.
function undoneMessage(restored: number, count: number): string {
  if (restored === 0) return strings.notices.moveAlreadyCommitted;
  if (restored < count) {
    return strings.notices.moveUndonePartial(restored, count);
  }
  return strings.notices.moveUndone(restored);
}

export function hasUndoableMove(): boolean {
  return useAppStore
    .getState()
    .notices.some((notice) => notice.id === UNDO_MOVE_NOTICE_ID);
}

/** Runs the Undo action of the open move notice. Returns false if none. */
export function undoLastMove(): boolean {
  const notice = useAppStore
    .getState()
    .notices.find((item) => item.id === UNDO_MOVE_NOTICE_ID);
  const action = notice?.actions?.find((item) => item.id === UNDO_ACTION_ID);
  if (!action) return false;
  void action.run();
  return true;
}
