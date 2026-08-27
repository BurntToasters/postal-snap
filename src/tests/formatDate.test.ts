import { afterEach, describe, expect, it } from "vitest";
import { formatMessageDate, shortcutMod, shortcutShiftMod } from "../format";
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
});

describe("shortcut labels", () => {
  afterEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it("uses Command symbols on macOS", () => {
    document.documentElement.dataset.platform = "macos";
    expect(shortcutMod()).toBe("⌘");
    expect(shortcutShiftMod()).toBe("⇧⌘");
  });

  it("uses Ctrl labels on other platforms", () => {
    document.documentElement.dataset.platform = "linux";
    expect(shortcutMod()).toBe("Ctrl");
    expect(shortcutShiftMod()).toBe("Ctrl+Shift");
  });
});
