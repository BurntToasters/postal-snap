import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Density token invariants plus a repeatable artifact in artifacts/0.4.3/.
const dir = join(process.cwd(), "artifacts", "0.4.3", "density-tokens");
const densities = ["comfortable", "compact"] as const;
const scales = [1, 2] as const;

async function load(page: Page, density: string, scale: number) {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?density=${density}&scale=${scale}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  await expect
    .poll(() =>
      page.locator("html").evaluate((n) => getComputedStyle(n).fontSize),
    )
    .toBe(`${scale * 16}px`);
}

// Probe elements are built from the real stylesheet classes.
async function mountFixture(page: Page) {
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "density-fixture";
    host.className = "settings-panel";
    host.style.cssText =
      "position:fixed;inset:0 auto auto 0;z-index:9999;width:30rem;padding:1rem;background:Canvas;color:CanvasText;display:grid;gap:0.5rem";
    host.innerHTML = `
      <label class="switch-row" id="fx-switch"><span>Switch</span><input type="checkbox" checked /></label>
      <div class="settings-row" id="fx-row"><span>Row</span></div>
      <label><input type="checkbox" id="fx-check" /> Check</label>
      <button class="full-button" id="fx-full" type="button">Full</button>
      <button class="provider-button" id="fx-provider" type="button"><span>P</span><span>Provider</span><span>&gt;</span></button>
      <div class="folder-tree-row" id="fx-tree"><button class="folder-expand" type="button">v</button><span class="folder-row">Folder</span></div>
      <div style="position:relative"><ul class="recipient-suggestions" id="fx-sugg">${Array.from(
        { length: 12 },
        (_, i) =>
          `<li><span>Person ${i}</span><small>p${i}@example.test</small></li>`,
      ).join("")}</ul></div>`;
    document.body.append(host);
  });
}

const probe = (page: Page) =>
  page.evaluate(() => {
    const px = (v: string) => parseFloat(v);
    const rect = (s: string) =>
      document.querySelector(s)!.getBoundingClientRect();
    const resolve = (token: string) => {
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;visibility:hidden;height:var(${token})`;
      document.body.append(el);
      const h = el.getBoundingClientRect().height;
      el.remove();
      return h;
    };
    const input = document.querySelector("#fx-switch input")!;
    const before = getComputedStyle(input, "::before");
    const inputBox = input.getBoundingClientRect();
    // Track box from computed pseudo-element geometry (top is 50%).
    const trackH = px(before.height);
    const trackW = px(before.width);
    const trackLeft = px(before.left);
    const trackTop = px(before.top) - trackH / 2;
    return {
      target: resolve("--target-size"),
      barSm: resolve("--bar-height-sm"),
      switchBox: { w: inputBox.width, h: inputBox.height },
      track: {
        left: trackLeft,
        top: trackTop,
        right: trackLeft + trackW,
        bottom: trackTop + trackH,
      },
      check: rect("#fx-check").width,
      sugg: px(getComputedStyle(document.querySelector("#fx-sugg")!).maxHeight),
      row: rect("#fx-row").height,
      full: rect("#fx-full").height,
      provider: rect("#fx-provider").height,
      expand: rect("#fx-tree .folder-expand").width,
    };
  });

type Probe = Awaited<ReturnType<typeof probe>>;
const results: Record<string, Probe> = {};

test.describe("density tokens 0.4.3", () => {
  test.setTimeout(60_000);

  for (const density of densities)
    for (const scale of scales)
      test(`probe ${density} ${scale}x`, async ({ page }) => {
        await load(page, density, scale);
        await mountFixture(page);
        const p = await probe(page);
        results[`${density}-${scale}x`] = p;

        // Switch track stays inside its box and is vertically centered.
        expect(p.track.top).toBeGreaterThanOrEqual(-0.5);
        expect(p.track.bottom).toBeLessThanOrEqual(p.switchBox.h + 0.5);
        expect(p.track.right).toBeLessThanOrEqual(p.switchBox.w + 0.5);
        expect(p.track.top).toBeCloseTo(p.switchBox.h - p.track.bottom, 0);
        // Checkbox tracks text size.
        expect(p.check).toBeCloseTo(20 * scale, 0);
        // Suggestions show about six rows.
        expect(p.sugg).toBeCloseTo(264 * scale, 0);
        // Expand button follows the inset token.
        expect(p.expand).toBeGreaterThanOrEqual(Math.min(p.target - 8, 28));

        await mkdir(dir, { recursive: true });
        const name = `${density}-${scale}x`;
        await page.locator("#density-fixture").screenshot({
          animations: "disabled",
          path: join(dir, `${name}-fixture.png`),
        });
        await page.locator("#fx-switch").screenshot({
          animations: "disabled",
          path: join(dir, `${name}-switch.png`),
        });
        await page.locator("#fx-provider").screenshot({
          animations: "disabled",
          path: join(dir, `${name}-provider.png`),
        });
        await page.locator("#fx-tree").screenshot({
          animations: "disabled",
          path: join(dir, `${name}-folder-tree.png`),
        });
      });

  test("compact never exceeds comfortable and sizes come from tokens", async ({
    browser,
  }) => {
    const out: Record<string, Probe> = {};
    for (const density of densities)
      for (const scale of scales) {
        const page = await browser.newPage();
        await load(page, density, scale);
        await mountFixture(page);
        out[`${density}-${scale}x`] = await probe(page);
        await page.close();
      }
    for (const scale of scales) {
      const c = out[`comfortable-${scale}x`];
      const k = out[`compact-${scale}x`];
      expect(k.target).toBeLessThanOrEqual(c.target);
      expect(k.barSm).toBeLessThanOrEqual(c.barSm);
      expect(k.row).toBeLessThanOrEqual(c.row);
      if (scale === 1) expect(k.row).toBeLessThan(c.row);
      expect(k.full).toBeLessThanOrEqual(c.full);
      if (scale === 1) expect(k.full).toBeLessThan(c.full);
      expect(k.provider).toBeLessThanOrEqual(c.provider);
      if (scale === 1) expect(k.provider).toBeLessThan(c.provider);
    }
    // Suggestion cap grows with text.
    expect(out["comfortable-2x"].sugg).toBeGreaterThan(
      out["comfortable-1x"].sugg,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "metrics.json"),
      `${JSON.stringify(out, null, 2)}\n`,
    );
  });
});
