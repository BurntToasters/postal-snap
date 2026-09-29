import { CalendarDays } from "lucide-react";
import { strings } from "../../i18n";
import type { CalendarInvite } from "../../types";
import { formatInviteRange } from "./inviteTime";

export function InviteCard({ invite }: { invite: CalendarInvite }) {
  const label = strings.reader.inviteMethod(invite.method, invite.status);
  const cancelled = invite.method === "CANCEL" || invite.status === "CANCELLED";
  const when = formatInviteRange(invite.start, invite.end);
  const organizer = invite.organizerName
    ? invite.organizerEmail
      ? `${invite.organizerName} <${invite.organizerEmail}>`
      : invite.organizerName
    : (invite.organizerEmail ?? "");
  return (
    <section
      className="invite-card"
      aria-label={strings.reader.invitation}
      data-cancelled={cancelled ? "true" : undefined}
    >
      <div className="invite-card-head">
        <CalendarDays aria-hidden="true" />
        <span className="invite-method">{label}</span>
      </div>
      <h2 className="invite-title">
        {invite.summary || strings.reader.inviteUntitled}
      </h2>
      <dl className="invite-details">
        {when ? (
          <>
            <dt>{strings.reader.inviteWhen}</dt>
            <dd>{when}</dd>
          </>
        ) : null}
        {invite.location ? (
          <>
            <dt>{strings.reader.inviteWhere}</dt>
            {/* Plain text on purpose: never a link. */}
            <dd className="invite-location">{invite.location}</dd>
          </>
        ) : null}
        {organizer ? (
          <>
            <dt>{strings.reader.inviteOrganizer}</dt>
            <dd>{organizer}</dd>
          </>
        ) : null}
      </dl>
      <p className="invite-note">{strings.reader.inviteNoRsvp}</p>
    </section>
  );
}
