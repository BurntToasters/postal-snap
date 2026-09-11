import { describe, expect, it } from "vitest";
import variablesCss from "../styles/variables.css?raw";

function color(block: string, property: string): string {
  const value = block.match(
    new RegExp(`--${property}:\\s*(#[0-9a-f]{6})`, "i"),
  );
  if (!value) throw new Error(`Missing --${property} color token.`);
  return value[1];
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function themeBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = variablesCss.match(
    new RegExp(`${escaped}\\s*{([\\s\\S]*?)\\n}`),
  );
  if (!block) throw new Error(`Missing ${selector} theme block.`);
  return block[1];
}

describe("color accessibility tokens", () => {
  for (const [theme, selector] of [
    ["light", ":root"],
    ["dark", ':root[data-theme="dark"]'],
  ]) {
    it(`${theme} theme keeps text and focus indicators distinguishable`, () => {
      const block = themeBlock(selector);
      const accent = color(block, "accent");
      const accentContrast = color(block, "accent-contrast");
      const focus = color(block, "focus");
      const surface = color(block, "surface");

      expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accentContrast, accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(focus, surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(focus, accent)).toBeGreaterThanOrEqual(3);
    });
  }
});
