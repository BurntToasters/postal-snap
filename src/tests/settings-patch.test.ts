import { describe, expect, it } from "vitest";
import { applySettingsPatch, mergeSettingsPatches } from "../settings";
import { defaultSettings } from "../store";

describe("settings patches", () => {
  it("keeps both nested cache fields when two patches overlap", () => {
    const merged = mergeSettingsPatches(
      { cachePolicy: { days: 30 } },
      { cachePolicy: { maxBytes: 524_288_000 } },
    );
    expect(merged.cachePolicy).toEqual({
      days: 30,
      maxBytes: 524_288_000,
    });
    expect(applySettingsPatch(defaultSettings, merged).cachePolicy).toEqual({
      mode: "recent",
      days: 30,
      maxBytes: 524_288_000,
    });
  });

  it("does not drop a top-level field while merging cache policy", () => {
    const next = applySettingsPatch(defaultSettings, {
      density: "compact",
      cachePolicy: { days: 180 },
    });
    expect(next.density).toBe("compact");
    expect(next.cachePolicy).toEqual({
      mode: "recent",
      days: 180,
      maxBytes: 1_073_741_824,
    });
    expect(next.theme).toBe(defaultSettings.theme);
  });
});
