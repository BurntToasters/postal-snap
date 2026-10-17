import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { strings } from "../i18n";
import {
  isAssertiveNotice,
  type Notice,
  type NoticeAction,
  type NoticeEndReason,
} from "../notices";
import { useAppStore } from "../store";

// Both live regions stay mounted, even when empty, so the first notice is announced.
// They carry aria-live only; no role, so existing role=status/alert lookups stay unique.
export function NoticeRegion() {
  const notices = useAppStore((state) => state.notices);
  return (
    <div className="notice-region">
      <div className="notice-stack" aria-live="polite">
        {notices
          .filter((notice) => !isAssertiveNotice(notice))
          .map((notice) => (
            <NoticeItem key={notice.id} notice={notice} />
          ))}
      </div>
      <div className="notice-stack" aria-live="assertive">
        {notices
          .filter((notice) => isAssertiveNotice(notice))
          .map((notice) => (
            <NoticeItem key={notice.id} notice={notice} />
          ))}
      </div>
    </div>
  );
}

// Ends a notice unless a same-id replacement has taken its slot.
function endIfCurrent(notice: Notice, reason: NoticeEndReason) {
  const store = useAppStore.getState();
  if (store.notices.find((item) => item.id === notice.id) !== notice) return;
  store.dismissNotice(notice.id, reason);
}

function NoticeItem({ notice }: { notice: Notice }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [running, setRunning] = useState(false);
  const remaining = useRef(notice.timeoutMs ?? 0);
  const owner = useRef(notice);
  const paused = hovered || focused || running;
  const assertive = isAssertiveNotice(notice);

  // A same-id replacement can land under a resting pointer with no enter event.
  useEffect(() => {
    try {
      setHovered(ref.current?.matches(":hover") ?? false);
    } catch {
      // Hover is unavailable here; focus and pointer events still apply.
    }
  }, [notice]);

  useEffect(() => {
    if (owner.current !== notice) {
      owner.current = notice;
      remaining.current = notice.timeoutMs ?? 0;
    }
    if (notice.timeoutMs === null || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(
      () => endIfCurrent(notice, "timeout"),
      remaining.current,
    );
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [notice, paused]);

  async function runAction(action: NoticeAction) {
    setRunning(true);
    try {
      await action.run();
    } catch {
      useAppStore.getState().pushNotice({
        severity: "error",
        message: strings.notices.actionFailed,
        timeoutMs: null,
      });
    }
    endIfCurrent(notice, "action");
  }

  const dismissLabel = assertive
    ? strings.app.dismissError
    : strings.notices.dismiss;

  return (
    <div
      ref={ref}
      className={`toast notice notice-${notice.severity}${assertive ? " error-toast" : ""}`}
      role={assertive ? "alert" : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      <span>{notice.message}</span>
      {notice.actions?.map((action) => (
        <button
          key={action.id}
          type="button"
          className="notice-action"
          disabled={running}
          onClick={() => void runAction(action)}
        >
          {action.label}
        </button>
      ))}
      <button
        type="button"
        className="notice-dismiss"
        disabled={running}
        onClick={() => endIfCurrent(notice, "dismiss")}
        aria-label={dismissLabel}
        title={dismissLabel}
      >
        <X size="1em" aria-hidden="true" />
      </button>
    </div>
  );
}
