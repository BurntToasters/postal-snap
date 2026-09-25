import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// Message listing, fetching, flagging, moving, bulk actions, and sync.
// The init script below is stringified into the page, so keep it
// self-contained: type-only imports, locals, and browser globals only.
export async function registerMockMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    const { mailboxes, summary, olderSummary, secondSummary, params } = mock;
    let paginatedCursorConsumed = false;
    Object.assign(mock.handlers, {
      list_messages(args: Record<string, unknown>) {
        if (state.moved || params.has("empty"))
          return { items: [], nextCursor: null, hasMore: false };
        if (location.search.includes("pagination")) {
          if (!args.cursor) {
            return {
              items: [summary],
              nextCursor: {
                receivedAt: summary.receivedAt,
                uid: summary.uid,
              },
              hasMore: true,
            };
          }
          const cursor = args.cursor as { receivedAt?: unknown; uid?: unknown };
          if (paginatedCursorConsumed) {
            throw new Error(
              "The message list reused a spent pagination cursor.",
            );
          }
          if (
            cursor.receivedAt !== summary.receivedAt ||
            cursor.uid !== summary.uid
          ) {
            throw new Error(
              "The message list sent a cursor that did not round-trip from the previous page.",
            );
          }
          paginatedCursorConsumed = true;
          return { items: [olderSummary], nextCursor: null, hasMore: false };
        }
        return {
          items: [
            args.accountId === secondSummary.accountId
              ? secondSummary
              : summary,
          ],
          nextCursor: null,
          hasMore: false,
        };
      },
      get_message(args: Record<string, unknown>) {
        if (params.has("oversize")) {
          throw {
            code: "limitExceeded",
            message: "That item exceeds Postal Snap's safety limit.",
            retryable: false,
          };
        }
        const selected =
          args.accountId === secondSummary.accountId ? secondSummary : summary;
        return {
          ...selected,
          to: [selected.recipients],
          cc: [],
          replyTo: null,
          textBody: "Are we still meeting on Saturday?",
          htmlBody: location.search.includes("threatLink")
            ? '<p><a href="https://phish.example.test/login">Open site</a></p>'
            : location.search.includes("webLink")
              ? '<p><a href="https://library.example.test/hours">Open site</a></p>'
              : location.search.includes("credentialLink")
                ? '<p><a href="https://trusted.example@phish.example.test/login">Open site</a></p>'
                : location.search.includes("remote")
                  ? '<p>Are we still meeting?</p><img src="https://images.example.test/pixel.png">'
                  : location.search.includes("inline")
                    ? '<p>Photo:</p><img src="cid:family-photo@example.test">'
                    : "<p>Are we still meeting on Saturday?</p>",
          remoteImagesBlocked: false,
          references: [],
          attachments: location.search.includes("inline")
            ? [
                {
                  id: "inline-1",
                  filename: "family.png",
                  contentType: "image/png",
                  size: 128,
                  contentId: "<family-photo@example.test>",
                  inline: true,
                },
              ]
            : location.search.includes("previewable")
              ? [
                  {
                    id: "attach-1",
                    filename: "family.png",
                    contentType: "image/png",
                    size: 128,
                    contentId: null,
                    inline: false,
                  },
                ]
              : [],
        };
      },
      set_message_flags(args: Record<string, unknown>) {
        if (typeof args.isRead === "boolean") {
          const wasRead = summary.isRead;
          summary.isRead = args.isRead;
          if (wasRead !== summary.isRead)
            mailboxes[0].unreadCount = Math.max(
              0,
              mailboxes[0].unreadCount + (summary.isRead ? -1 : 1),
            );
        }
        if (typeof args.isStarred === "boolean")
          summary.isStarred = args.isStarred;
        return undefined;
      },
      move_message() {
        state.moved = true;
        mailboxes[0].totalCount = 0;
        mailboxes[0].unreadCount = 0;
        mailboxes[1].totalCount = 1;
        mailboxes[1].unreadCount = summary.isRead ? 0 : 1;
        return undefined;
      },
      set_messages_flags(args: Record<string, unknown>) {
        const ids = (args.messageIds ?? []) as number[];
        if (args.isRead === true) summary.isRead = true;
        return { updated: ids.length, queued: 0, failed: 0 };
      },
      move_messages_to_mailbox(args: Record<string, unknown>) {
        state.moved = true;
        return {
          updated: ((args.messageIds ?? []) as number[]).length,
          queued: 0,
          failed: 0,
        };
      },
      mark_mailbox_read() {
        summary.isRead = true;
        mailboxes[0].unreadCount = 0;
        return { updated: 1, queued: 0, failed: 0 };
      },
      sync_account() {
        return undefined;
      },
      sync_all_accounts() {
        return mock.accounts.map((account) => account.id);
      },
      release_compose_attachments() {
        return undefined;
      },
    });
  });
}
