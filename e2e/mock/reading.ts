import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// M1 reading features: List-Unsubscribe, original source, invitation card,
// and replied/forwarded marks. Wraps the base get_message and send handlers.
// The init script below is stringified into the page, so keep it
// self-contained: type-only imports, locals, and browser globals only.
export async function registerMockReading(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    const { params, summary } = mock;
    type Handler = (args: Record<string, unknown>) => unknown;
    const baseGetMessage = mock.handlers.get_message as Handler;
    const baseSend = mock.handlers.send_message as Handler;
    const baseScheduled = mock.handlers.send_scheduled_outbox as
      Handler | undefined;

    const unsubscribeFor = (kind: string | null) => {
      if (kind === "oneClick")
        return {
          oneClick: true,
          httpsUrl: "https://lists.example.test/u?id=42",
          httpsHost: "lists.example.test",
          mailto: null,
        };
      if (kind === "mailto")
        return {
          oneClick: false,
          httpsUrl: null,
          httpsHost: null,
          mailto:
            "mailto:leave-42@lists.example.test?subject=unsubscribe&body=Please%20remove%20me",
        };
      if (kind === "https")
        return {
          oneClick: false,
          httpsUrl: "https://lists.example.test/manage?id=42",
          httpsHost: "lists.example.test",
          mailto: null,
        };
      return null;
    };
    const inviteFor = (kind: string | null) => {
      if (kind === "request")
        return {
          method: "REQUEST",
          status: "CONFIRMED",
          summary: "Planning lunch",
          start: {
            iso: "2026-10-01T15:00:00Z",
            allDay: false,
            utc: true,
            tzid: null,
          },
          end: {
            iso: "2026-10-01T16:00:00Z",
            allDay: false,
            utc: true,
            tzid: null,
          },
          location: "Room 4, https://maps.example.test/room4",
          organizerName: "Sam Lee",
          organizerEmail: "sam.lee@example.test",
        };
      if (kind === "cancel")
        return {
          method: "CANCEL",
          status: "CANCELLED",
          summary: "Planning lunch",
          start: {
            iso: "2026-10-01T15:00:00Z",
            allDay: false,
            utc: true,
            tzid: null,
          },
          end: null,
          location: null,
          organizerName: null,
          organizerEmail: "sam.lee@example.test",
        };
      if (kind === "tzid")
        return {
          method: "REQUEST",
          status: null,
          summary: "Standup",
          start: {
            iso: "2026-10-01T09:00:00",
            allDay: false,
            utc: false,
            tzid: "America/New_York",
          },
          end: {
            iso: "2026-10-01T09:30:00",
            allDay: false,
            utc: false,
            tzid: "America/New_York",
          },
          location: null,
          organizerName: null,
          organizerEmail: null,
        };
      if (kind === "allDay")
        return {
          method: "PUBLISH",
          status: null,
          summary: "Company holiday",
          start: { iso: "2026-10-12", allDay: true, utc: false, tzid: null },
          end: { iso: "2026-10-13", allDay: true, utc: false, tzid: null },
          location: null,
          organizerName: null,
          organizerEmail: null,
        };
      return null;
    };

    const invite = inviteFor(params.get("invite"));
    if (invite) summary.hasCalendar = true;

    function emit(event: string, payload: unknown) {
      for (const handler of state.eventListeners.get(event) ?? []) {
        state.callbacks.get(handler)?.({ event, id: handler, payload });
      }
    }

    // Mirrors commands/replied.rs: only a confirmed SMTP send marks the
    // source, and only for a source in the sending account.
    function markSource(draft: unknown, outcome: string) {
      if (outcome !== "sent" && outcome !== "sent_copy_pending") return;
      const value = draft as
        | {
            accountId?: string;
            sourceMessageId?: number | null;
            sourceKind?: string | null;
          }
        | undefined;
      if (!value?.sourceKind || value.sourceMessageId !== summary.id) return;
      if (value.accountId !== summary.accountId) return;
      if (value.sourceKind === "forward") summary.isForwarded = true;
      else summary.isAnswered = true;
      emit("message-changed", {
        accountId: summary.accountId,
        messageId: summary.id,
        kind: "flags",
      });
    }
    let lastDraft: unknown;

    Object.assign(mock.handlers, {
      get_message(args: Record<string, unknown>) {
        const detail = baseGetMessage(args) as Record<string, unknown>;
        return {
          ...detail,
          hasCalendar: Boolean(invite),
          isAnswered: summary.isAnswered ?? false,
          isForwarded: summary.isForwarded ?? false,
          unsubscribe: unsubscribeFor(params.get("unsub")),
          invite,
        };
      },
      send_message(args: Record<string, unknown>) {
        lastDraft = args.draft;
        const result = baseSend(args) as { state: string };
        markSource(args.draft, result.state);
        return result;
      },
      send_scheduled_outbox(args: Record<string, unknown>) {
        const result = (baseScheduled?.(args) ?? {
          id: "outbox-1",
          state: "sent",
          detail: null,
        }) as { state: string };
        markSource(lastDraft, result.state);
        return result;
      },
      unsubscribe_one_click() {
        // Rust re-reads the stored header; a message without one-click fails.
        if (params.get("unsub") !== "oneClick")
          throw new Error(
            "This message does not support one-click unsubscribe.",
          );
        if (params.has("unsubFail"))
          throw new Error("The sender's server did not accept the request.");
        return undefined;
      },
      get_message_source() {
        return {
          headers: [
            { name: "From", value: "Jane <jane@example.com>" },
            { name: "Subject", value: "Weekend plans" },
            { name: "Message-ID", value: "<weekend@example.com>" },
            { name: "Content-Type", value: "text/html; charset=utf-8" },
          ],
          source: [
            "From: Jane <jane@example.com>",
            "Subject: Weekend plans",
            "Message-ID: <weekend@example.com>",
            "Content-Type: text/html; charset=utf-8",
            "",
            '<p onclick="alert(1)">Not rendered</p><script>window.__pwned = 1</script>',
          ].join("\r\n"),
          truncated: false,
          size: 256,
        };
      },
      save_message_eml() {
        return undefined;
      },
    });
  });
}
