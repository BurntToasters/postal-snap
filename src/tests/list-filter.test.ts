import { describe, expect, it } from "vitest";
import { matchesListFilter, rememberedFilter } from "../listFilter";
import { rememberedSort } from "../listSort";
import { makeMessage } from "./helpers/fixtures";

describe("mailbox list filter", () => {
  it("keeps unread, starred, and attachment rows", () => {
    const unread = makeMessage({ id: 1, isRead: false, isStarred: true });
    const filed = makeMessage({ id: 2, isRead: true, hasAttachments: true });
    expect(matchesListFilter(unread, "all")).toBe(true);
    expect(matchesListFilter(filed, "all")).toBe(true);
    expect(matchesListFilter(unread, "unread")).toBe(true);
    expect(matchesListFilter(filed, "unread")).toBe(false);
    expect(matchesListFilter(unread, "starred")).toBe(true);
    expect(matchesListFilter(filed, "starred")).toBe(false);
    expect(matchesListFilter(unread, "attachments")).toBe(false);
    expect(matchesListFilter(filed, "attachments")).toBe(true);
    expect(matchesListFilter({ ...unread, pinned: true }, "pinned")).toBe(true);
    expect(matchesListFilter(filed, "pinned")).toBe(false);
    expect(matchesListFilter({ ...unread, toMe: true }, "toMe")).toBe(true);
    expect(matchesListFilter(filed, "toMe")).toBe(false);
    expect(rememberedFilter("toMe")).toBe("toMe");
    expect(
      matchesListFilter({ ...unread, hasCalendar: true }, "invitations"),
    ).toBe(true);
    expect(matchesListFilter(filed, "invitations")).toBe(false);
    expect(rememberedFilter("invitations")).toBe("invitations");
  });

  it("keeps a saved filter and order, and falls back when they are unknown", () => {
    expect(rememberedFilter("pinned")).toBe("pinned");
    expect(rememberedFilter("sideways")).toBe("all");
    expect(rememberedSort("sizeAsc")).toBe("sizeAsc");
    expect(rememberedSort("sideways")).toBe("date");
  });
});
