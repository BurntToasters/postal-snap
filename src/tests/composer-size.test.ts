import { describe, expect, it } from "vitest";
import { rememberedComposerSize } from "../composerSize";

describe("remembered compose window size", () => {
  it("keeps a size inside the compose window limits", () => {
    expect(rememberedComposerSize(0, 0)).toBeUndefined();
    expect(rememberedComposerSize(479, 360)).toBeUndefined();
    expect(rememberedComposerSize(480, 359)).toBeUndefined();
    expect(rememberedComposerSize(Number.NaN, 500)).toBeUndefined();
    expect(rememberedComposerSize(700.4, 500.6)).toEqual({
      width: 700,
      height: 501,
    });
  });
});
