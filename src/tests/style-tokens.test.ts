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

// Blends an rgb(... / alpha%) token over an opaque hex background.
function blend(translucent: string, background: string): string {
  const match = translucent.match(
    /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d+(?:\.\d+)?)%\s*\)/,
  );
  if (!match) throw new Error(`Unsupported color: ${translucent}`);
  const alpha = Number(match[4]) / 100;
  const bg = background
    .slice(1)
    .match(/../g)!
    .map((value) => Number.parseInt(value, 16));
  const mixed = [1, 2, 3].map((index) =>
    Math.round(alpha * Number(match[index]) + (1 - alpha) * bg[index - 1]),
  );
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function themeBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = variablesCss.match(
    new RegExp(`${escaped}\\s*{([\\s\\S]*?)\\n}`),
  );
  if (!block) throw new Error(`Missing ${selector} theme block.`);
  return block[1];
}

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return map;
}

describe("color accessibility tokens", () => {
  for (const [theme, selector] of [
    ["light", ":root"],
    ["dark", ':root[data-resolved-theme="dark"]'],
  ]) {
    it(`${theme} theme keeps text and focus indicators distinguishable`, () => {
      const block = themeBlock(selector);
      const accent = color(block, "accent");
      const accentFill = color(block, "accent-fill");
      const accentContrast = color(block, "accent-contrast");
      const surface = color(block, "surface");
      // --focus is an alias of --accent, so the ring matches the accent.
      expect(declarations(themeBlock(":root")).get("--focus")).toBe(
        "var(--accent)",
      );
      const focusOnAccent = color(themeBlock(":root"), "focus-on-accent");

      expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accentContrast, accentFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(focusOnAccent, accentFill)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme} theme keeps accent text and muted text readable`, () => {
      const block = themeBlock(selector);
      const accentInk = color(block, "accent-ink");
      const surfaceMuted = color(block, "surface-muted");
      const surfaceRaised = color(block, "surface-raised");
      const sidebarBg = color(block, "sidebar-bg");
      const textMuted = block.match(/--text-muted:\s*([^;]+);/)![1];

      expect(contrast(accentInk, surfaceMuted)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accentInk, surfaceRaised)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(blend(textMuted.trim(), sidebarBg), sidebarBg),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("dark palette is defined once, under the resolved theme", () => {
    expect(variablesCss).not.toContain("prefers-color-scheme");
    expect(variablesCss).not.toContain('data-theme="dark"');
    expect(
      declarations(themeBlock(':root[data-resolved-theme="dark"]')).size,
    ).toBeGreaterThan(0);
  });
});
