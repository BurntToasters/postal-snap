import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section F):
// F3  The focused row unmounts while scrolling, so focus drops to body.
// F5  Shift+arrow range selection misreads rows that are not mounted.
// F6  Rows lose aria-setsize, aria-posinset, or tree aria-level.
// F9  Removing day headers from the accessibility tree loses row dates.
// Each test ends with a screenshot and the recorded IPC calls.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await attachArtifacts(page, testInfo, `list-virtual-keyboard-${slug}`);
});

function row(page: Page, subject: string) {
  return page.getByRole("option", { name: new RegExp(`${subject},`) });
}

test("focus stays on the row after scrolling far down with End and arrows", async ({
  page,
}) => {
  await page.goto("/?hugeList=1500&theme=light");
  await row(page, "Archive note 1").focus();
  await expect(row(page, "Archive note 1")).toBeFocused();

  await page.keyboard.press("End");
  await expect(row(page, "Archive note 1500")).toBeFocused();

  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("ArrowUp");
  }
  await expect(row(page, "Archive note 1460")).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe("BUTTON");

  await page.keyboard.press("Home");
  await expect(row(page, "Archive note 1")).toBeFocused();
});

test("Shift+arrow selects a range across rows that are not mounted", async ({
  page,
}) => {
  await page.goto("/?hugeList=1500&theme=light");
  await row(page, "Archive note 1").focus();
  await page.keyboard.press("x");
  await expect(page.locator(".bulk-bar strong")).toHaveText("1 selected");

  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press("Shift+ArrowDown");
  }
  await expect(row(page, "Archive note 31")).toBeFocused();
  await expect(page.locator(".bulk-bar strong")).toHaveText("31 selected");

  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press("Shift+ArrowUp");
  }
  await expect(row(page, "Archive note 21")).toBeFocused();
  await expect(page.locator(".bulk-bar strong")).toHaveText("21 selected");
});

test("rows expose set size and position across the whole list", async ({
  page,
}) => {
  await page.goto("/?hugeList=1500&theme=light");
  const first = row(page, "Archive note 1");
  await expect(first).toHaveAttribute("aria-posinset", "1");
  await expect(first).toHaveAttribute("aria-setsize", "1500");

  await first.focus();
  await page.keyboard.press("End");
  const last = row(page, "Archive note 1500");
  await expect(last).toHaveAttribute("aria-posinset", "1500");
  await expect(last).toHaveAttribute("aria-setsize", "1500");
});

test("row names keep the date while day headings are hidden", async ({
  page,
}) => {
  await page.goto("/?hugeList=1500&theme=light");
  const first = row(page, "Archive note 1");
  await expect(first).toBeVisible();
  const date = await first.locator(".message-date").getAttribute("title");
  expect(date).toBeTruthy();
  expect(await first.getAttribute("aria-label")).toContain(date ?? "");

  const headings = await page
    .locator(".message-list .list-day")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        Boolean(node.closest('[role="presentation"], [aria-hidden="true"]')),
      ),
    );
  expect(headings.length).toBeGreaterThan(0);
  expect(headings.every(Boolean)).toBe(true);
});

test("thread rows keep tree levels and set counts", async ({ page }) => {
  await page.goto("/?threadGap=1&theme=light");
  const header = page.getByRole("treeitem", {
    name: /^Conversation,.*Weekend plans/,
  });
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute("aria-level", "1");
  await expect(header).toHaveAttribute("aria-setsize", /^\d+$/);
  await expect(header).toHaveAttribute("aria-posinset", /^\d+$/);

  await header.focus();
  await page.keyboard.press("ArrowRight");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const child = page.locator('[role="treeitem"][aria-level="2"]').first();
  await expect(child).toBeVisible();
  await expect(child).toHaveAttribute("aria-setsize", /^\d+$/);
});

test("the list has no serious accessibility violations", async ({ page }) => {
  await page.goto("/?hugeList=1500&theme=light");
  await expect(row(page, "Archive note 1")).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .include(".message-list")
    .analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});
