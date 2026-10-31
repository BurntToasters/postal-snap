import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Deep audit for reader findings: More-menu viewport clamping at 620x540
// with 200% text, Escape/focus behavior, icon-button targets, reply names,
// recipient titles, and snooze Escape focus return.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openWeekend(
  page: Page,
  query = "",
  size = { width: 1280, height: 800 },
) {
  await page.setViewportSize(size);
  await page.goto(`/?${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
}

for (const theme of ["light", "dark"] as const) {
  test(`more menu stays inside a 620x540 viewport at 200% (${theme})`, async ({
    page,
  }) => {
    await openWeekend(page, `scale=2&theme=${theme}`, {
      width: 620,
      height: 540,
    });
    await page.getByRole("button", { name: "More actions" }).click();
    const menu = page.getByRole("menu", { name: "More actions" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(620);
    const state = await menu.evaluate((node) => ({
      bottom: node.getBoundingClientRect().bottom,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    const available = 540 - box!.y - 8;
    if (state.bottom > 540) {
      expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
      expect(state.clientHeight).toBeLessThanOrEqual(available + 1);
    } else {
      expect(state.bottom).toBeLessThanOrEqual(540);
    }
    const items = await menu.getByRole("menuitem").evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: (node.textContent ?? "").trim(),
        clipped: node.scrollWidth > node.clientWidth + 1,
      })),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].text.length).toBeGreaterThan(0);
    expect(items[0].clipped).toBe(false);
    const last = items[items.length - 1];
    expect(last.text.length).toBeGreaterThan(0);
    expect(last.clipped).toBe(false);
  });
}

test("more menu stays inside a 1280 viewport at 100%", async ({ page }) => {
  await openWeekend(page, "theme=light&nestedFolders=1");
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
  await expect(menu.getByRole("group", { name: "Move to" })).toBeVisible();
});

test("Escape closes the more menu and restores trigger focus", async ({
  page,
}) => {
  await openWeekend(page, "theme=light");
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("button", { name: "More actions" }),
  ).toBeFocused();
});

test("icon-only reader actions keep a 44px target at comfortable 100%", async ({
  page,
}) => {
  await openWeekend(page, "theme=light");
  const bar = page.locator(".reader-actions");
  for (const name of ["Add star", "Archive", "Move to trash", "More actions"]) {
    const box = await bar
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
});

test("reply actions keep their accessible name at 620 200%", async ({
  page,
}) => {
  await openWeekend(page, "scale=2&theme=light", { width: 620, height: 540 });
  for (const name of ["Reply", "Reply all", "Forward"]) {
    await expect(
      page.getByRole("button", { name, exact: true }).first(),
    ).toHaveAttribute("aria-label", name);
  }
});

test("a single recipient preview exposes its full text as a title", async ({
  page,
}) => {
  await openWeekend(page, "theme=light");
  const preview = page.locator(".recipient-preview[title]").first();
  await expect(preview).toHaveAttribute("title", /@/);
});

test("reader snooze Escape closes and returns focus to the trigger", async ({
  page,
}) => {
  await openWeekend(page, "theme=light");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
  const panel = page.locator(".snooze-panel");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(
    page.getByRole("button", { name: "More actions" }),
  ).toBeFocused();
});

test("bulk snooze Escape closes and returns focus to the trigger", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  // Rows toggle selection in select mode; the visual checkbox is decorative.
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Snooze selected" }).click();
  const panel = page.locator(".snooze-panel");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(
    page.getByRole("button", { name: "More mailbox actions" }),
  ).toBeFocused();
});
