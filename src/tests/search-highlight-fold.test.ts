import { describe, expect, it } from "vitest";
import { highlightParts } from "../searchHighlight";

// Failure modes covered here:
// 1. Lowercasing changes length ("İ" becomes two code units), so marks shift
//    onto the wrong characters of the original text.
// 2. Astral characters split in half or matched across a surrogate pair.
// 3. Marks lose text, so joined parts no longer equal the original string.

const joined = (parts: { text: string }[]) =>
  parts.map((part) => part.text).join("");

describe("highlightParts keeps indices on the original text", () => {
  it("marks the exact word after a length-changing character", () => {
    const text = "İİ Hello";
    const parts = highlightParts(text, ["hello"]);
    expect(joined(parts)).toBe(text);
    expect(parts.find((part) => part.mark)?.text).toBe("Hello");
  });

  it("keeps astral characters intact around a match", () => {
    const text = "𐐀 target 𐐨";
    const parts = highlightParts(text, ["target"]);
    expect(joined(parts)).toBe(text);
    expect(parts.find((part) => part.mark)?.text).toBe("target");
  });

  it("still matches case-insensitively with no length change", () => {
    const parts = highlightParts("Quarterly REPORT", ["report"]);
    expect(parts).toEqual([
      { text: "Quarterly ", mark: false },
      { text: "REPORT", mark: true },
    ]);
  });
});
