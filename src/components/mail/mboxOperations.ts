import { useSyncExternalStore } from "react";
import { api } from "../../api";
import { errorText } from "../../errors";
import { strings } from "../../i18n";
import { noticeTimeout, type NoticeSeverity } from "../../notices";
import { useAppStore } from "../../store";

// One mbox job at a time. The progress notice reads this; results go to the notice queue.
export interface MboxJob {
  kind: "export" | "import";
  /** Learned from the first progress event; Cancel waits for it. */
  operationId?: string;
  done: number;
  total: number;
  cancelling: boolean;
}

interface MboxResult {
  operationId?: string | null;
  skipped: number;
}

let job: MboxJob | null = null;
const listeners = new Set<() => void>();

function setJob(next: MboxJob | null) {
  job = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Reads through a function so TypeScript does not narrow the guard above.
function currentJob(): MboxJob | null {
  return job;
}

export function useMboxJob(): MboxJob | null {
  return useSyncExternalStore(subscribe, () => job);
}

function notify(severity: NoticeSeverity, message: string) {
  useAppStore.getState().pushNotice({
    severity,
    message,
    timeoutMs: noticeTimeout(severity),
  });
}

export function cancelMboxJob() {
  const current = job;
  if (!current?.operationId || current.cancelling) return;
  setJob({ ...current, cancelling: true });
  api.cancelMboxOperation(current.operationId).catch(() => {
    notify("error", strings.mail.mboxFailed);
  });
}

async function runMboxJob<T extends MboxResult>(
  kind: MboxJob["kind"],
  call: () => Promise<T>,
  countText: (result: T) => string,
  onFinished?: () => Promise<void>,
) {
  if (job) return;
  setJob({ kind, done: 0, total: 0, cancelling: false });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await api.onMboxProgress((event) => {
      const current = job;
      if (!current) return;
      if (current.operationId && current.operationId !== event.operationId)
        return;
      setJob({
        ...current,
        operationId: event.operationId,
        done: event.done,
        total: event.total,
      });
    });
    const result = await call();
    setJob(null);
    // A dismissed save or open dialog returns no operation: nothing ran.
    if (!result.operationId) return;
    const skipped =
      result.skipped > 0
        ? ` ${strings.mail.mboxSkippedCount(result.skipped)}`
        : "";
    notify("success", `${countText(result)}${skipped}`);
    void onFinished?.().catch(() => undefined);
  } catch (cause) {
    const wasCancelling = currentJob()?.cancelling === true;
    setJob(null);
    if (wasCancelling) notify("info", strings.mail.mboxCancelled);
    else notify("error", errorText(cause));
  } finally {
    unlisten?.();
  }
}

export function startMboxExport(accountId: string, mailboxId: number) {
  void runMboxJob(
    "export",
    () => api.exportMailboxMbox(accountId, mailboxId),
    (result) => strings.mail.mboxExportedCount(result.exported),
  );
}

export function startMboxImport(
  accountId: string,
  mailboxId: number,
  onImported: () => Promise<void>,
) {
  void runMboxJob(
    "import",
    () => api.importMbox(accountId, mailboxId),
    (result) => strings.mail.mboxImportedCount(result.imported),
    onImported,
  );
}
