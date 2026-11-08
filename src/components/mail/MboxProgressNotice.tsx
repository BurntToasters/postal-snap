import { strings } from "../../i18n";
import { cancelMboxJob, useMboxJob } from "./mboxOperations";

// Shows only once the operation has an id, so a dismissed dialog never flashes.
export function MboxProgressNotice() {
  const job = useMboxJob();
  if (!job?.operationId) return null;
  const label =
    job.kind === "export"
      ? strings.mail.mboxExporting(job.done, job.total)
      : strings.mail.mboxImporting(job.done, job.total);
  return (
    // Progress updates are frequent; the notice stays quiet for screen readers.
    <div className="toast notice notice-info" aria-live="off">
      <span>{label}</span>
      <progress
        value={job.done}
        max={Math.max(job.total, 1)}
        aria-label={label}
        aria-valuenow={job.done}
        aria-valuemin={0}
        aria-valuemax={job.total}
      />
      <button
        type="button"
        className="notice-action"
        disabled={job.cancelling}
        onClick={cancelMboxJob}
      >
        {job.cancelling ? strings.mail.mboxCancelling : strings.mail.mboxCancel}
      </button>
    </div>
  );
}
