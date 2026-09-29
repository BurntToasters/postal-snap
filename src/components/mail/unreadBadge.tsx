function unreadBadgeText(count: number): string {
  return count > 999 ? "999+" : String(count);
}

interface Props {
  count: number;
  /** Full spoken text, for example "12 unread". */
  label: string;
}

/** Visible count is capped; screen readers get the exact label. */
export function UnreadBadge({ count, label }: Props) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return (
    <span className="account-unread">
      <span aria-hidden="true">{unreadBadgeText(count)}</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
