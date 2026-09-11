import { Inbox, Pencil, Trash2 } from "lucide-react";
import { strings } from "../../i18n";
import type { MailboxRole } from "../../types";

export function FolderButton({
  icon: Icon,
  label,
  count,
  active,
  tone,
  onClick,
  onRename,
  onDelete,
}: {
  icon: typeof Inbox;
  label: string;
  count: number;
  active: boolean;
  tone?: "warning" | MailboxRole;
  onClick: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="folder-row">
      <button
        type="button"
        className={`folder ${active ? "active" : ""} ${tone ?? ""}`}
        onClick={onClick}
        aria-current={active ? "page" : undefined}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        {count > 0 ? <strong>{count > 999 ? "999+" : count}</strong> : null}
      </button>
      {onRename ? (
        <button
          type="button"
          className="icon-button folder-action"
          onClick={onRename}
          aria-label={`${strings.mail.rename} ${label}`}
          title={`${strings.mail.rename} ${label}`}
        >
          <Pencil aria-hidden="true" />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          className="icon-button folder-action"
          onClick={onDelete}
          aria-label={`${strings.mail.deleteFolder}: ${label}`}
          title={`${strings.mail.deleteFolder}: ${label}`}
        >
          <Trash2 aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
