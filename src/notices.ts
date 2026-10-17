// Notice queue types shared by the store and NoticeRegion.
export type NoticeSeverity = "info" | "success" | "warning" | "error";

/** How a notice ended. `replaced` covers same-id updates and overflow. */
export type NoticeEndReason = "action" | "dismiss" | "timeout" | "replaced";

export interface NoticeAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

export interface Notice {
  id: string;
  severity: NoticeSeverity;
  message: string;
  actions?: NoticeAction[];
  /** Auto-dismiss delay in milliseconds. Null keeps the notice until dismissed. */
  timeoutMs: number | null;
  /**
   * Total visible time from arrival, and the longest a hover or focus pause
   * may stretch it. Once reached the notice ends even while paused.
   */
  maxVisibleMs?: number;
  source?: string;
  onEnd?: (reason: NoticeEndReason) => void;
}

export type NoticeInput = Omit<Notice, "id"> & { id?: string };

/** Fixed id for the notice that mirrors the legacy `setError` slot. */
export const LEGACY_ERROR_NOTICE_ID = "legacy-error";
export const NOTICE_LIMIT = 3;
export const DEFAULT_NOTICE_TIMEOUT_MS = 8_000;

/**
 * Hard cap on a pauseable notice's total visible time. The backend holds a
 * deferred move for its 60-second undo window (UNDO_HOLD_SECONDS, minus buffer
 * for the round trip), so 55 seconds is the longest an Undo notice can stay
 * open, even with the pointer resting on it.
 */
export const UNDO_NOTICE_MAX_MS = 55_000;

/** Errors never auto-dismiss, whatever timeout a caller passes. */
export function noticeTimeout(severity: NoticeSeverity): number | null {
  return severity === "error" ? null : DEFAULT_NOTICE_TIMEOUT_MS;
}

/** Errors use the assertive live region; everything else is polite. */
export function isAssertiveNotice(notice: Pick<Notice, "severity">): boolean {
  return notice.severity === "error";
}
