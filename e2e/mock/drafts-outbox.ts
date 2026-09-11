import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// Drafts, outbox, snooze, search, send, suggestions, forward preparation,
// and compose image reads. The init script below is stringified into the
// page, so keep it self-contained: type-only imports, locals, and browser
// globals only.
export async function registerMockDraftsOutbox(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    const { account, summary } = mock;
    Object.assign(mock.handlers, {
      list_drafts() {
        return location.search.includes("localMail")
          ? [
              {
                id: "draft-1",
                accountId: account.id,
                recipients: "pat@example.com",
                subject: "Family update",
                updatedAt: "2026-08-18T10:00:00Z",
                syncState: location.search.includes("conflict")
                  ? "conflict"
                  : "synced",
                syncDetail: location.search.includes("conflict")
                  ? "A server edit was preserved as this recovered copy."
                  : null,
              },
            ]
          : [];
      },
      get_draft() {
        return {
          id: "draft-1",
          accountId: account.id,
          to: ["pat@example.com"],
          cc: [],
          bcc: [],
          subject: "Family update",
          htmlBody: "<p>Draft message</p>",
          textBody: "Draft message",
          attachments: location.search.includes("draftInline")
            ? [
                {
                  token: "managed-inline",
                  filename: "photo.png",
                  contentType: "image/png",
                  inline: true,
                  contentId: "draft-photo@example.test",
                },
              ]
            : [],
        };
      },
      list_outbox() {
        if (!location.search.includes("localMail") || state.discarded) {
          return [];
        }
        return [
          {
            id: "outbox-1",
            accountId: account.id,
            recipients: "lee@example.com",
            subject: "Could not confirm",
            state: location.search.includes("sentCopy")
              ? "sent_copy_pending"
              : location.search.includes("queued")
                ? "queued"
                : location.search.includes("scheduled")
                  ? "scheduled"
                  : "needs_attention",
            detail: location.search.includes("sentCopy")
              ? "Message sent. Its Sent-folder copy is waiting for a safe retry."
              : location.search.includes("queued")
                ? "Waiting for a secure mail connection."
                : location.search.includes("scheduled")
                  ? "Held for review. Undo anytime before it sends."
                  : "Delivery could not be confirmed.",
            createdAt: "2026-08-18T11:00:00Z",
            sendAt: location.search.includes("scheduled")
              ? new Date(Date.now() + 60_000).toISOString()
              : null,
          },
        ];
      },
      get_outbox() {
        return {
          accountId: account.id,
          to: ["lee@example.com"],
          cc: [],
          bcc: [],
          subject: "Could not confirm",
          htmlBody: "<p>Please review</p>",
          textBody: "Please review",
          attachments: [],
        };
      },
      retry_outbox() {
        state.retried = true;
        return { id: "outbox-1", state: "sent", detail: null };
      },
      retry_sent_copy() {
        return { id: "outbox-1", state: "sent", detail: null };
      },
      delete_outbox() {
        state.discarded = true;
        return undefined;
      },
      restore_outbox() {
        state.discarded = true;
        return {
          accountId: "acc-1",
          to: ["sam@example.test"],
          cc: [],
          bcc: [],
          subject: "Queued",
          htmlBody: "<p>Queued</p>",
          textBody: "Queued",
          attachments: [],
        };
      },
      set_mail_shortcut_guard() {
        return undefined;
      },
      snooze_message() {
        state.snoozed = true;
        return undefined;
      },
      unsnooze_message() {
        return undefined;
      },
      list_snoozed() {
        return [];
      },
      delete_draft() {
        return undefined;
      },
      search_cached_messages(args: Record<string, unknown>) {
        const search = args.query as { allFolders?: boolean } | undefined;
        return [
          {
            ...summary,
            subject: search?.allFolders ? "Across account" : "Current mailbox",
          },
        ];
      },
      search_server_messages(args: Record<string, unknown>) {
        const search = args.query as { allFolders?: boolean } | undefined;
        return [
          {
            ...summary,
            subject: search?.allFolders ? "Across account" : "Current mailbox",
          },
        ];
      },
      save_draft() {
        return { id: "draft-1", syncState: "localPending" };
      },
      send_message(args: Record<string, unknown>) {
        state.sentDraft = args.draft;
        return { id: "outbox-1", state: "sent", detail: null };
      },
      choose_attachments() {
        return [];
      },
      preview_attachment() {
        return {
          filename: "family.png",
          contentType: "image/png",
          size: 128,
          text: null,
          imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        };
      },
      suggest_recipients() {
        return [
          {
            address: "jane@example.com",
            name: "Jane",
            useCount: 3,
          },
        ];
      },
      prepare_forward_attachments() {
        return location.search.includes("forwardAttachment")
          ? [
              {
                token: "forwarded-token",
                filename: "family-plan.pdf",
                contentType: "application/pdf",
                inline: false,
                contentId: null,
              },
            ]
          : [];
      },
      read_compose_image() {
        return "data:image/png;base64,iVBORw0KGgo=";
      },
    });
  });
}
