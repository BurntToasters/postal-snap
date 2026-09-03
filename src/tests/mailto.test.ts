import { describe, expect, it } from "vitest";
import { parseMailto } from "../mailto";

describe("mailto links", () => {
  it("prefills recipients, subject, and body", () => {
    expect(
      parseMailto(
        "mailto:jane%40example.com?cc=sam%40example.com&subject=Family%20visit&body=See%20you%20soon",
      ),
    ).toEqual({
      to: ["jane@example.com"],
      cc: ["sam@example.com"],
      subject: "Family visit",
      textBody: "See you soon",
    });
  });

  it("bounds hostile prefill sizes", () => {
    const many = Array.from(
      { length: 300 },
      (_, index) => `a${index}@x.test`,
    ).join(",");
    const parsed = parseMailto(
      `mailto:${encodeURIComponent(many)}?subject=${"s".repeat(5000)}&body=${"b".repeat(500_000)}`,
    );
    expect(parsed.to).toHaveLength(100);
    expect(parsed.subject).toHaveLength(998);
    expect(parsed.textBody).toHaveLength(100_000);
  });
});
