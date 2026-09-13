import { afterEach, describe, expect, it } from "vitest";
import {
  formatBytes,
  formatFullMessageDate,
  formatMessageDate,
  shortcutAltMod,
  shortcutMod,
  shortcutShiftMod,
} from "../format";
import { strings } from "../i18n";

describe("formatMessageDate", () => {
  const now = new Date(2026, 7, 27, 15, 0, 0);

  it("shows time for mail from today", () => {
    const text = formatMessageDate(
      new Date(2026, 7, 27, 9, 30, 0).toISOString(),
      now,
    );
    expect(text).toMatch(/\d/);
    expect(text).not.toBe(strings.mail.yesterday);
  });

  it("labels yesterday", () => {
    expect(
      formatMessageDate(new Date(2026, 7, 26, 18, 0, 0).toISOString(), now),
    ).toBe(strings.mail.yesterday);
  });

  it("uses a weekday name within the last few days", () => {
    const text = formatMessageDate(
      new Date(2026, 7, 24, 12, 0, 0).toISOString(),
      now,
    );
    expect(text).toMatch(/mon/i);
  });

  it("uses a short date for older mail this year", () => {
    const text = formatMessageDate(
      new Date(2026, 0, 5, 12, 0, 0).toISOString(),
      now,
    );
    expect(text.toLowerCase()).toMatch(/jan/);
    expect(text).not.toMatch(/2026/);
  });

  it("includes the year for mail from another year", () => {
    const text = formatMessageDate(
      new Date(2024, 11, 1, 12, 0, 0).toISOString(),
      now,
    );
    expect(text).toMatch(/2024/);
  });

  it("returns malformed dates unchanged", () => {
    expect(formatMessageDate("not-a-date", now)).toBe("not-a-date");
  });
});

describe("full dates and byte sizes", () => {
  const now = new Date(2026, 7, 27, 15, 0, 0);

  it.each([
    [new Date(2026, 7, 27, 14, 59, 45), strings.mail.justNow],
    [new Date(2026, 7, 27, 14, 45, 0), strings.mail.minutesAgo(15)],
    [new Date(2026, 7, 27, 12, 0, 0), strings.mail.hoursAgo(3)],
    [new Date(2026, 7, 26, 12, 0, 0), strings.mail.yesterday.toLowerCase()],
    [new Date(2026, 7, 20, 12, 0, 0), strings.mail.daysAgo(7)],
  ])("adds useful relative context", (date, relative) => {
    expect(formatFullMessageDate(date.toISOString(), now)).toContain(relative);
  });

  it("omits relative context for old or future dates", () => {
    expect(formatFullMessageDate("not-a-date", now)).toBe("not-a-date");
    expect(
      formatFullMessageDate(new Date(2025, 0, 1).toISOString(), now),
    ).not.toContain("(");
    expect(
      formatFullMessageDate(new Date(2026, 8, 1).toISOString(), now),
    ).not.toContain("(");
  });

  it("formats bytes through B, KB, MB, and GB", () => {
    expect(formatBytes(100)).toBe("100 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

describe("shortcut labels", () => {
  afterEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it("uses Command symbols on macOS", () => {
    document.documentElement.dataset.platform = "macos";
    expect(shortcutMod()).toBe("⌘");
    expect(shortcutShiftMod()).toBe("⇧⌘");
    expect(shortcutAltMod()).toBe("⌥⌘");
  });

  it("uses Ctrl labels on other platforms", () => {
    document.documentElement.dataset.platform = "linux";
    expect(shortcutMod()).toBe("Ctrl");
    expect(shortcutShiftMod()).toBe("Ctrl+Shift");
    expect(shortcutAltMod()).toBe("Ctrl+Alt");
  });
});
