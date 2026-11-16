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
    const basePreview = mock.handlers.preview_attachment as Handler;
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

    // A large multipart message stored without its attachment bodies. Its
    // IDs change once download_full_message stores the full message.
    const partialMessage = params.has("partialMessage");
    const rfcMessage = params.has("rfcMessage");
    let fullDownloaded = false;
    const partialFiles = [
      {
        id: "partial-report",
        filename: "Quarterly report.pdf",
        contentType: "application/pdf",
        size: 0,
        contentId: null,
        inline: false,
      },
      {
        id: "partial-photo",
        filename: "family.png",
        contentType: "image/png",
        size: 0,
        contentId: null,
        inline: false,
      },
    ];
    const fullFiles = [
      {
        id: "full-report",
        filename: "Quarterly report.pdf",
        contentType: "application/pdf",
        size: 12_400_000,
        contentId: null,
        inline: false,
      },
      {
        id: "full-photo",
        filename: "family.png",
        contentType: "image/png",
        size: 128,
        contentId: null,
        inline: false,
      },
    ];

    function emit(event: string, payload: unknown) {
      for (const handler of state.eventListeners.get(event) ?? []) {
        state.callbacks.get(handler)?.({ event, id: handler, payload });
      }
    }

    // A 1x1 PNG stands in for each rendered PDF page.
    const PNG_PAGE =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const openedMessages = new Map<
      string,
      { token: string; message: unknown }
    >();
    function emlMessage() {
      return {
        id: 0,
        accountId: mock.account.id,
        mailboxId: 0,
        uid: 0,
        messageId: "<lease@example.test>",
        subject: "Lease renewal",
        senderName: "Riley Ng",
        senderAddress: "riley@example.test",
        recipients: "sam@icloud.com",
        receivedAt: "2026-07-02T09:30:00Z",
        preview: "Here is the signed lease.",
        isRead: true,
        isStarred: false,
        flagColor: 0,
        hasAttachments: true,
        attachmentCount: 1,
        size: 4096,
        threadRoot: null,
        to: ["sam@icloud.com"],
        cc: [],
        textBody: "Here is the signed lease. Thanks, Riley.",
        // ?emlHtml adds a script and a remote image to the HTML body.
        htmlBody: params.has("emlHtml")
          ? '<p>Here is the signed lease.</p><img src="https://tracker.example.test/pixel.png" alt=""><script>window.__pwned = 1</script>'
          : null,
        remoteImagesBlocked: false,
        attachments: [
          {
            id: "pdf-1",
            filename: "Lease.pdf",
            contentType: "application/pdf",
            size: 2048,
            contentId: null,
            inline: false,
          },
          {
            id: "forwarded-1",
            filename: "Forwarded.eml",
            contentType: "message/rfc822",
            size: 900,
            contentId: null,
            inline: false,
          },
        ],
      };
    }
    // ?emlSeeded starts the page with an opened message already in place.
    if (params.has("emlSeeded"))
      openedMessages.set("opened-eml-1", {
        token: "opened-eml-1",
        message: emlMessage(),
      });
    function openedFor(args: Record<string, unknown>) {
      const opened = openedMessages.get(String(args.token));
      if (!opened)
        throw mock.mockError("notFound", "This message is no longer open.");
      return opened;
    }
    function mailboxFor(args: Record<string, unknown>) {
      const box = mock.mailboxes.find(
        (item) =>
          item.id === Number(args.mailboxId) &&
          item.accountId === args.accountId,
      );
      if (!box) throw mock.mockError("notFound", "Mailbox not found.");
      return box;
    }
    // Mirrors the Rust progress cadence: a start event, then one per message.
    // Cancel sets the flag; the export stops at its next progress step.
    let mboxCancelled = false;
    async function reportProgress(operationId: string, total: number) {
      for (let done = 0; done <= total; done++) {
        if (mboxCancelled) return false;
        emit("mbox-progress", { operationId, done, total });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return true;
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
        const partial = partialMessage && args.messageId === summary.id;
        const withFiles = rfcMessage && args.messageId === summary.id;
        return {
          ...detail,
          ...(withFiles
            ? {
                hasAttachments: true,
                attachmentCount: 2,
                attachments: [
                  {
                    id: "mail-pdf",
                    filename: "Lease.pdf",
                    contentType: "application/pdf",
                    size: 2048,
                    contentId: null,
                    inline: false,
                  },
                  {
                    id: "mail-rfc",
                    filename: "Forwarded.eml",
                    contentType: "message/rfc822",
                    size: 900,
                    contentId: null,
                    inline: false,
                  },
                ],
              }
            : {}),
          hasCalendar: Boolean(invite),
          bodyPartial: partial && !fullDownloaded,
          ...(partial
            ? {
                size: 13_002_342,
                attachments: fullDownloaded ? fullFiles : partialFiles,
              }
            : {}),
          isAnswered: summary.isAnswered ?? false,
          isForwarded: summary.isForwarded ?? false,
          unsubscribe: unsubscribeFor(params.get("unsub")),
          invite,
        };
      },
      // ?rfcMessage gives the selected mailbox message a PDF and a forwarded message.
      preview_attachment(args: Record<string, unknown>) {
        if (args.attachmentId !== "mail-pdf") return basePreview(args);
        return {
          filename: "Lease.pdf",
          contentType: "application/pdf",
          size: 2048,
          text: null,
          imageDataUrl: null,
          pages: [PNG_PAGE, PNG_PAGE, PNG_PAGE],
          pageCount: 3,
          pagesTruncated: false,
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
          throw mock.mockError(
            "operationFailed",
            "This message does not support one-click unsubscribe.",
          );
        if (params.has("unsubFail"))
          throw mock.mockError(
            "operationFailed",
            "The sender's server did not accept the request.",
          );
        return undefined;
      },
      download_full_message(args: Record<string, unknown>) {
        fullDownloaded = true;
        return (mock.handlers.get_message as Handler)(args);
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
      save_conversation_attachments() {
        return 2;
      },
      save_messages_eml() {
        return 2;
      },
      // .eml viewer, mbox export/import, and opened-message attachments.
      // Opened messages live outside the mailbox, so tokens key them here.
      open_eml_file() {
        if (params.has("emlCancel")) return null;
        const opened = { token: "opened-eml-1", message: emlMessage() };
        openedMessages.set(opened.token, opened);
        return opened;
      },
      get_opened_message(args: Record<string, unknown>) {
        return openedFor(args);
      },
      close_opened_message(args: Record<string, unknown>) {
        openedMessages.delete(String(args.token));
        return undefined;
      },
      save_opened_attachment(args: Record<string, unknown>) {
        openedFor(args);
        return undefined;
      },
      preview_opened_attachment(args: Record<string, unknown>) {
        openedFor(args);
        if (args.attachmentId !== "pdf-1")
          throw mock.mockError("notFound", "Attachment not found.");
        const truncated = params.has("pdfTruncated");
        // ?pdfBadPage puts a non-data URL first; the viewer must drop it.
        const pages = Array.from({ length: truncated ? 8 : 3 }, () => PNG_PAGE);
        if (params.has("pdfBadPage"))
          pages[0] = "https://tracker.example.test/page.png";
        return {
          filename: "Lease.pdf",
          contentType: "application/pdf",
          size: 2048,
          text: null,
          imageDataUrl: null,
          pages,
          pageCount: truncated ? 12 : 3,
          pagesTruncated: truncated,
        };
      },
      view_attachment_message(args: Record<string, unknown>) {
        if (
          args.attachmentId !== "forwarded-1" &&
          args.attachmentId !== "mail-rfc"
        )
          throw mock.mockError("notFound", "Attachment not found.");
        const opened = {
          token: "opened-attached-1",
          message: { ...emlMessage(), subject: "Forwarded note" },
        };
        openedMessages.set(opened.token, opened);
        return opened;
      },
      async export_mailbox_mbox(args: Record<string, unknown>) {
        const box = mailboxFor(args);
        if (params.has("mboxDismissed"))
          return { operationId: null, exported: 0, skipped: 0 };
        if (params.has("mboxLimit"))
          throw mock.mockError(
            "limitExceeded",
            "Too many messages to export at once.",
          );
        mboxCancelled = false;
        const operationId = "mbox-export-1";
        const finished = await reportProgress(operationId, box.totalCount);
        if (!finished)
          throw mock.mockError("operationFailed", "Export stopped.");
        // ?mboxSkipped=1 counts two messages as too large to export.
        const skipped = params.has("mboxSkipped") ? 2 : 0;
        return {
          operationId,
          exported: box.totalCount - skipped,
          skipped,
        };
      },
      async import_mbox(args: Record<string, unknown>) {
        mailboxFor(args);
        if (params.has("mboxDismissed"))
          return { operationId: null, imported: 0, skipped: 0 };
        const operationId = "mbox-import-1";
        await reportProgress(operationId, 3);
        return { operationId, imported: 2, skipped: 1 };
      },
      cancel_mbox_operation() {
        mboxCancelled = true;
        return undefined;
      },
      start_attachment_drag() {
        throw mock.mockError("operationFailed", "Not available yet.");
      },
      start_message_drag() {
        throw mock.mockError("operationFailed", "Not available yet.");
      },
    });
  });
}
