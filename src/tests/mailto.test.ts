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
});
