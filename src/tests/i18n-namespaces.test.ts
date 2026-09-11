import { describe, expect, it } from "vitest";
import { strings } from "../i18n";

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      collectStrings(entry, out);
    }
  }
}

describe("i18n namespaces", () => {
  it("exposes the send labels (source catalog has no strings.mail.send key)", () => {
    // The v0.1 catalog never had a `strings.mail.send` key; adding one would
    // break the byte-identical split. The canonical Send labels are:
    expect(strings.composer.send).toBe("Send");
    expect(strings.mail.sendNow).toBe("Send now");
    expect(
      (strings.mail as unknown as Record<string, unknown>).send,
    ).toBeUndefined();
  });

  it("keeps the danger-zone erase label", () => {
    expect(strings.settings.eraseButton).toBe("Reset & Restart");
  });

  it("never claims a confirmed threat verdict", () => {
    // Allowed words that legitimately contain the substring "confirmed".
    const allowed = [/unconfirmed/i];
    const values: string[] = [];
    collectStrings(strings, values);
    const violations = values.filter(
      (value) =>
        /confirmed/i.test(value) &&
        !allowed.some((pattern) => pattern.test(value)),
    );
    expect(violations).toEqual([]);
  });

  it("preserves function-valued keys", () => {
    expect(strings.mail.snoozedUntil("9 AM")).toBe("Snoozed until 9 AM");
    expect(strings.reader.previewTitle("photo.png")).toBe(
      "Preview of photo.png",
    );
    expect(strings.composer.removeAttachment("invoice.pdf")).toBe(
      "Remove invoice.pdf",
    );
  });
});
