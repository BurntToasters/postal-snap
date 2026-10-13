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
    const { account, summary, params } = mock;
    let duplicatedDraft = false;
    let discardedDraft = false;
    let lastSendOutcome: string | undefined;
    let lastSendDetail: string | null = null;
    let lastSendAccountId: string | undefined;
    let recentSearches: string[] = [];
    const archiveWarningKey = "postal-snap-e2e-archive-warning";
    const readArchiveWarning = () => {
      const value = localStorage.getItem(archiveWarningKey);
      return value
        ? (JSON.parse(value) as {
            state: string;
            sendCount: number;
            archiveRetryCount: number;
            sentCopyRetryCount: number;
            detail: string;
          })
        : undefined;
    };
    const saveArchiveWarning = (value: {
      state: string;
      sendCount: number;
      archiveRetryCount: number;
      sentCopyRetryCount: number;
      detail: string;
    }) => localStorage.setItem(archiveWarningKey, JSON.stringify(value));
    Object.assign(mock.handlers, {
      list_drafts() {
        if (!location.search.includes("localMail") || discardedDraft) return [];
        const original = {
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
          preview: params.has("draftPreview")
            ? "Seeing the family Friday."
            : "",
          attachmentCount: params.has("draftFiles") ? 2 : 0,
          fromAddress: params.has("draftFrom")
            ? params.get("draftFrom") === "account"
              ? account.email
              : "alias@example.com"
            : "",
          sourceMessageId:
            params.get("replyDraft") === "other"
              ? 99
              : params.has("replyDraft")
                ? 10
                : null,
          sourceKind:
            params.get("replyDraft") === "forward"
              ? "forward"
              : params.has("replyDraft") && params.get("replyDraft") !== "other"
                ? "reply"
                : null,
        };
        if (params.get("replyDraft") === "two") {
          return [
            {
              ...original,
              id: "draft-2",
              updatedAt: "2026-08-18T12:00:00Z",
              syncState: "localPending",
              syncDetail: null,
            },
            original,
          ];
        }
        return duplicatedDraft
          ? [
              {
                ...original,
                id: "draft-2",
                updatedAt: "2026-08-18T12:00:00Z",
                syncState: "localPending",
                syncDetail: null,
              },
              original,
            ]
          : [original];
      },
      get_draft(args: Record<string, unknown>) {
        return {
          id: String(args.draftId ?? "draft-1"),
          accountId: account.id,
          from: null,
          to: ["pat@example.com"],
          cc: [],
          bcc: [],
          subject: "Family update",
          bodyFormat: location.search.includes("plainDraft") ? "plain" : "html",
          htmlBody: location.search.includes("plainDraft")
            ? ""
            : "<p>Draft message</p>",
          textBody: location.search.includes("plainDraft")
            ? "Plain draft line\n> quoted line"
            : "Draft message",
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
          inReplyTo: null,
          references: null,
          sendAt: null,
        };
      },
      list_outbox(args: Record<string, unknown>) {
        if (location.search.includes("pendingConnectionWork")) {
          const accountId = String(args.accountId ?? "");
          return [
            {
              id: `outbox-${accountId}`,
              accountId,
              recipients: "recipient@example.test",
              subject: `Unsent for ${accountId}`,
              state: "queued",
              detail: "Waiting for a secure mail connection.",
              createdAt: "2026-08-18T11:00:00Z",
              sendAt: null,
            },
          ];
        }
        if (
          location.search.includes("archiveWarning=1") ||
          location.search.includes("sentCopyArchiveWarning=1")
        ) {
          const persisted = readArchiveWarning();
          if (persisted?.state === "sent" || persisted?.state === "dismissed")
            return [];
          const initialState = location.search.includes(
            "sentCopyArchiveWarning=1",
          )
            ? "sent_copy_pending"
            : "scheduled";
          const rowState = persisted?.state ?? initialState;
          const detail =
            persisted?.detail ??
            (rowState === "sent_copy_pending"
              ? "Message sent. Its Sent-folder copy is waiting for a safe retry."
              : "Held for review. Undo anytime before it sends.");
          return [
            {
              id: "outbox-1",
              accountId: String(args.accountId ?? account.id),
              recipients: "lee@example.com",
              subject: "Quarterly notes",
              state: rowState,
              detail,
              createdAt: "2026-08-18T11:00:00Z",
              sendAt:
                rowState === "scheduled"
                  ? new Date(
                      Date.now() -
                        (location.search.includes("scheduledPast")
                          ? 60_000
                          : -60_000),
                    ).toISOString()
                  : null,
            },
          ];
        }
        if (!location.search.includes("localMail") || state.discarded) {
          return [];
        }
        if (lastSendAccountId && args.accountId !== lastSendAccountId)
          return [];
        const outcome =
          lastSendOutcome ??
          (location.search.includes("sentCopy")
            ? "sent_copy_pending"
            : location.search.includes("queued")
              ? "queued"
              : location.search.includes("scheduled")
                ? "scheduled"
                : "needs_attention");
        if (outcome === "sent") return [];
        const rows = [
          {
            id: "outbox-1",
            accountId: lastSendAccountId ?? account.id,
            recipients: "lee@example.com",
            subject: "Could not confirm",
            state: outcome,
            preview: params.has("outboxPreview")
              ? "Please review the notes."
              : "",
            attachmentCount: params.has("outboxFiles") ? 2 : 0,
            detail:
              lastSendDetail ??
              (outcome === "sent_copy_pending"
                ? "Message sent. Its Sent-folder copy is waiting for a safe retry."
                : outcome === "queued"
                  ? "Waiting for a secure mail connection."
                  : outcome === "scheduled"
                    ? "Held for review. Undo anytime before it sends."
                    : "Delivery could not be confirmed."),
            createdAt: params.has("noQueuedTime") ? "" : "2026-08-18T11:00:00Z",
            sendAt:
              outcome === "scheduled"
                ? new Date(
                    Date.now() +
                      (location.search.includes("scheduledPast")
                        ? -60_000
                        : location.search.includes("scheduledLater")
                          ? 5 * 60 * 60_000
                          : 60_000),
                  ).toISOString()
                : null,
          },
        ];
        if (params.has("attentionPair") && outcome === "needs_attention") {
          rows.push({
            ...rows[0],
            id: "outbox-2",
            subject: "Second unsent",
          });
        }
        return rows;
      },
      get_outbox() {
        const empty = location.search.includes("emptyOutbox");
        return {
          accountId: account.id,
          from: null,
          to: ["lee@example.com"],
          cc: [],
          bcc: [],
          subject: "Could not confirm",
          htmlBody: empty ? "<p></p>" : "<p>Please review</p>",
          textBody: empty ? "" : "Please review",
          attachments: empty
            ? []
            : [
                {
                  token: "file-1",
                  filename: "notes.txt",
                  inline: false,
                },
              ],
          inReplyTo: null,
          references: null,
          sendAt: null,
        };
      },
      retry_outbox() {
        state.retried = true;
        return { id: "outbox-1", state: "sent", detail: null };
      },
      retry_sent_copy() {
        if (location.search.includes("sentCopyArchiveWarning=1")) {
          const previous = readArchiveWarning();
          saveArchiveWarning({
            state: "archive_pending",
            sendCount: previous?.sendCount ?? 0,
            archiveRetryCount: previous?.archiveRetryCount ?? 0,
            sentCopyRetryCount: (previous?.sentCopyRetryCount ?? 0) + 1,
            detail:
              "Message sent. The archive status needs attention. Retry archive or dismiss this warning.",
          });
          return {
            id: "outbox-1",
            state: "archive_pending",
            detail:
              "Message sent. The archive status needs attention. Retry archive or dismiss this warning.",
          };
        }
        return { id: "outbox-1", state: "sent", detail: null };
      },
      send_scheduled_outbox(args: Record<string, unknown>) {
        if (location.search.includes("archiveWarning=1")) {
          const previous = readArchiveWarning();
          if (String(args.accountId ?? "") !== account.id)
            throw new Error(
              "Scheduled message does not belong to this account.",
            );
          const value = {
            state: "archive_pending",
            sendCount: (previous?.sendCount ?? 0) + 1,
            archiveRetryCount: previous?.archiveRetryCount ?? 0,
            sentCopyRetryCount: previous?.sentCopyRetryCount ?? 0,
            detail:
              "Message sent. The archive status needs attention. Retry archive or dismiss this warning.",
          };
          saveArchiveWarning(value);
          return { id: "outbox-1", state: value.state, detail: value.detail };
        }
        return { id: "outbox-1", state: "sent", detail: null };
      },
      retry_archive_after_send(args: Record<string, unknown>) {
        const previous = readArchiveWarning();
        if (
          !previous ||
          previous.state !== "archive_pending" ||
          String(args.accountId ?? "") !== account.id
        ) {
          throw new Error("No archive retry belongs to this account.");
        }
        saveArchiveWarning({
          ...previous,
          state: "sent",
          archiveRetryCount: previous.archiveRetryCount + 1,
        });
        return { id: "outbox-1", state: "sent", detail: null };
      },
      dismiss_archive_warning(args: Record<string, unknown>) {
        const previous = readArchiveWarning();
        if (
          !previous ||
          previous.state !== "archive_pending" ||
          String(args.accountId ?? "") !== account.id
        ) {
          throw new Error("No archive warning belongs to this account.");
        }
        saveArchiveWarning({ ...previous, state: "dismissed" });
        return undefined;
      },
      delete_outbox() {
        state.discarded = true;
        return undefined;
      },
      restore_outbox() {
        state.discarded = true;
        return {
          id: "draft-restored",
          accountId: account.id,
          from: null,
          to: ["sam@example.test"],
          cc: [],
          bcc: [],
          subject: "Queued",
          htmlBody: "<p>Queued</p>",
          textBody: "Queued",
          attachments: [],
          inReplyTo: null,
          references: null,
          sendAt: null,
        };
      },
      set_mail_shortcut_guard() {
        return undefined;
      },
      snooze_message(args: Record<string, unknown>) {
        state.snoozed = true;
        if (typeof args.messageId === "number")
          state.snoozedIds.push(args.messageId);
        return undefined;
      },
      snooze_messages(args: Record<string, unknown>) {
        state.snoozed = true;
        if (Array.isArray(args.messageIds)) {
          for (const id of args.messageIds) {
            if (typeof id === "number") state.snoozedIds.push(id);
          }
        }
        return undefined;
      },
      unsnooze_message(args: Record<string, unknown>) {
        state.snoozedIds = state.snoozedIds.filter(
          (id) => id !== args.messageId,
        );
        return undefined;
      },
      list_snoozed() {
        if (!location.search.includes("snoozedList")) return [];
        const row = (
          id: number,
          subject: string,
          senderName: string,
          senderAddress: string,
        ) => ({
          message: {
            id,
            accountId: "account-1",
            mailboxId: 1,
            uid: id,
            messageId: `<snooze-${id}@example.com>`,
            subject,
            senderName,
            senderAddress,
            recipients: "sam@icloud.com",
            receivedAt: "2026-08-18T12:00:00Z",
            preview: "",
            isRead: true,
            isStarred: false,
            hasAttachments: false,
            size: 256,
          },
          snoozedUntil: "2026-08-19T16:00:00Z",
        });
        return [
          row(81, "Dentist reminder", "Clinic", "clinic@example.com"),
          row(82, "Weekend plans", "Jane", "jane@example.com"),
        ];
      },
      delete_draft() {
        discardedDraft = true;
        return undefined;
      },
      list_recent_searches() {
        return recentSearches.slice();
      },
      remember_search(args: Record<string, unknown>) {
        const text = String(args.query ?? "").trim();
        if (!text) return recentSearches.slice();
        recentSearches = [
          text,
          ...recentSearches.filter(
            (query) => query.toLowerCase() !== text.toLowerCase(),
          ),
        ].slice(0, 8);
        return recentSearches.slice();
      },
      forget_recent_search(args: Record<string, unknown>) {
        const text = String(args.query ?? "")
          .trim()
          .toLowerCase();
        recentSearches = recentSearches.filter(
          (query) => query.toLowerCase() !== text,
        );
        return recentSearches.slice();
      },
      forget_recent_searches() {
        recentSearches = [];
        return undefined;
      },
      search_cached_messages(args: Record<string, unknown>) {
        const search = args.query as
          { allFolders?: boolean; text?: string } | undefined;
        // "bodyonly" text: only the server has the match.
        if (search?.text?.includes("bodyonly")) return [];
        const text = search?.text?.toLowerCase() ?? "";
        if (text.includes("elsewhere")) {
          return search?.allFolders
            ? [{ ...summary, id: 46, uid: 46, subject: "Across account" }]
            : [];
        }
        if (text.includes("on:")) {
          return [
            {
              ...summary,
              id: 45,
              uid: 45,
              subject: "August letter",
            },
          ];
        }
        if (text.includes("body:")) {
          return [
            {
              ...summary,
              id: 44,
              uid: 44,
              subject: "Receipt inside",
            },
          ];
        }
        if (text.includes("is:important")) {
          return [
            {
              ...summary,
              id: 41,
              uid: 41,
              subject: "Budget approval",
              importance: "high",
            },
          ];
        }
        if (text.includes("is:pinned")) {
          return [
            {
              ...summary,
              id: 43,
              uid: 43,
              subject: "Kept note",
              pinned: true,
            },
          ];
        }
        if (text.includes("is:low")) {
          return [
            {
              ...summary,
              id: 42,
              uid: 42,
              subject: "Optional note",
              importance: "low",
            },
          ];
        }
        return [
          {
            ...summary,
            subject: search?.allFolders ? "Across account" : "Current mailbox",
          },
        ];
      },
      search_server_messages(args: Record<string, unknown>) {
        const search = args.query as
          { allFolders?: boolean; text?: string } | undefined;
        if (search?.text?.includes("bodyonly"))
          return [
            { ...summary, id: 77, uid: 77, subject: "Server body match" },
          ];
        const text = search?.text?.toLowerCase() ?? "";
        if (text.includes("elsewhere")) return [];
        // Importance is stored locally, so the server has nothing to add.
        if (text.includes("on:")) {
          return [
            {
              ...summary,
              id: 79,
              uid: 79,
              subject: "Server august",
            },
          ];
        }
        if (text.includes("body:")) {
          return [
            {
              ...summary,
              id: 78,
              uid: 78,
              subject: "Server receipt",
            },
          ];
        }
        if (
          text.includes("is:important") ||
          text.includes("is:low") ||
          text.includes("is:pinned")
        )
          return [];
        return [
          {
            ...summary,
            subject: search?.allFolders ? "Across account" : "Current mailbox",
          },
        ];
      },
      save_draft(args: Record<string, unknown>) {
        const draft = args.draft as { id?: string | null } | undefined;
        if (!draft?.id) {
          duplicatedDraft = true;
          return { id: "draft-2", syncState: "localPending" };
        }
        return { id: draft.id, syncState: "localPending" };
      },
      send_message(args: Record<string, unknown>) {
        state.sentDraft = args.draft;
        const draft = args.draft as
          { accountId?: string; sendAt?: string | null } | undefined;
        lastSendAccountId = draft?.accountId;
        const requested = params.get("sendOutcome");
        const settings = mock.handlers.get_settings?.({}) as
          { undoSendSeconds?: number } | undefined;
        const delay = Math.min(settings?.undoSendSeconds ?? 10, 30);
        const offline = account.syncState === "offline";
        const offlineDetail = "Waiting for a secure mail connection.";
        // Mirror drafts_send.rs: an explicit schedule and the undo-send
        // window both hold the message, an offline account queues it, and only
        // an immediate online send can report success. A query switch lets
        // tests force any real outcome.
        lastSendOutcome =
          requested ??
          (draft?.sendAt
            ? "scheduled"
            : delay > 0
              ? "scheduled"
              : offline
                ? "queued"
                : "sent");
        if (lastSendOutcome === "queued") {
          // Online, "queued" means the server could not take it yet.
          lastSendDetail = offline
            ? offlineDetail
            : "Not sent yet. The mail server could not take it right now. Postal Snap will try again automatically.";
        } else if (lastSendOutcome === "scheduled") {
          lastSendDetail = draft?.sendAt
            ? offline
              ? offlineDetail
              : "Scheduled to send."
            : offline
              ? offlineDetail
              : "Held for review. Undo anytime before it sends.";
        } else if (lastSendOutcome === "sent_copy_pending") {
          lastSendDetail =
            "Message sent. Its Sent-folder copy is waiting for a safe retry.";
        } else if (lastSendOutcome === "needs_attention") {
          lastSendDetail =
            "Delivery could not be confirmed. Postal Snap will not resend automatically.";
        } else {
          lastSendDetail = null;
        }
        return {
          id: "outbox-1",
          state: lastSendOutcome,
          detail: lastSendDetail,
        };
      },
      stage_pasted_image() {
        return {
          token: "pasted-token",
          filename: "Pasted image.png",
          contentType: "image/png",
          inline: false,
          contentId: null,
          size: 68,
        };
      },
      choose_attachments() {
        if (location.search.includes("pickImage")) {
          return [
            {
              token: "picked-image",
              filename: "family-photo.jpg",
              contentType: "image/jpeg",
              inline: false,
              contentId: null,
              size: 2048,
            },
          ];
        }
        if (
          !location.search.includes("pickFile") &&
          !location.search.includes("pickPair")
        ) {
          return [];
        }
        const budget = {
          token: "picked-token-1",
          filename: "budget.pdf",
          contentType: "application/pdf",
          inline: false,
          contentId: null,
          ...(location.search.includes("sizeMissing") ? {} : { size: 4096 }),
        };
        if (!location.search.includes("pickPair")) return [budget];
        return [
          budget,
          {
            token: "picked-token-2",
            filename: "notes.txt",
            contentType: "text/plain",
            inline: false,
            contentId: null,
            size: 64,
          },
        ];
      },
      attach_dropped_files() {
        // Rust holds the paths; the UI only ever sees opaque tokens.
        return location.search.includes("dropEmpty")
          ? []
          : [
              {
                token: "dropped-token-1",
                filename: "family-photo.jpg",
                contentType: "image/jpeg",
                inline: false,
                contentId: null,
                size: 2048,
              },
              {
                token: "dropped-token-2",
                filename: "notes.txt",
                contentType: "text/plain",
                inline: false,
                contentId: null,
                size: 64,
              },
            ];
      },
      preview_attachment(args: Record<string, unknown>) {
        if (args.attachmentId === "attach-2") {
          return {
            filename: "notes.txt",
            contentType: "text/plain",
            size: 64,
            text: "Bring the salad.",
            imageDataUrl: null,
          };
        }
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
      prepare_reply_attachments() {
        return [
          {
            token: "reply-file",
            filename: "family.png",
            contentType: "image/png",
            inline: false,
            contentId: null,
            size: 128,
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
