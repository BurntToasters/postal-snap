import { mkdir, writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The row menu offers Print ▸ with Print message for a single message.
// 2. Print conversation appears in Print ▸ only inside a multi-message thread.
// 3. The row menu and the reader More menu list the shared groups in one order.
// Mock mailboxes give no Move to submenu, so the shared order skips it.
// Writes artifacts/0.5.2/menus/menu-model.json. Each test ends with a screenshot.

const ARTIFACT_DIR = "artifacts/0.5.2/menus";
const summary: Record<string, unknown> = {};

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/menu-print-pin-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test.afterAll(async () => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    `${ARTIFACT_DIR}/menu-model.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
});

/** Top-level labels of an open menu, in DOM order; separators read as "|". */
async function topLevelLabels(page: Page, root: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const menu = document.querySelector(selector);
    if (!menu) return [];
    const labels: string[] = [];
    for (const child of Array.from(menu.children)) {
      if (child.classList.contains("context-menu-separator")) {
        labels.push("|");
      } else if (child.classList.contains("popup-submenu")) {
        labels.push(
          child.querySelector(".context-menu-label")?.textContent?.trim() ?? "",
        );
      } else if (child.matches('[role="menuitem"]')) {
        labels.push(
          child.querySelector(".context-menu-label")?.textContent?.trim() ?? "",
        );
      }
    }
    return labels;
  }, root);
}

async function openRowMenu(page: Page, name: RegExp) {
  await page
    .getByRole("option", { name })
    .or(page.getByRole("treeitem", { name }))
    .click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
}

test("row Print offers Print message and omits Print conversation for a single message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page, /Library hours/i);
  await page.getByRole("menuitem", { name: "Print", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Print message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Print conversation", exact: true }),
  ).toHaveCount(0);
  summary.singleMessagePrintItems = await page
    .locator(".popup-submenu-panel [role='menuitem']")
    .allTextContents();
});

test("row Print message prints through the selection print path", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page, /Library hours/i);
  await page.getByRole("menuitem", { name: "Print", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Print message", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.printCalls ?? 0),
    )
    .toBe(1);
  summary.rowPrintCalls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.printCalls ?? 0,
  );
});

test("row Print offers Print conversation inside a thread", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page, /Weekend plans/i);
  await page.getByRole("menuitem", { name: "Print", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Print conversation", exact: true }),
  ).toBeVisible();
  summary.threadPrintItems = await page
    .locator(".popup-submenu-panel [role='menuitem']")
    .allTextContents();
});

test("row menu and reader More menu list the shared groups in one order", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page, /Weekend plans/i);
  const rowOrder = await topLevelLabels(page, ".context-menu");
  await page.keyboard.press("Escape");
  await expect(page.locator(".context-menu")).toHaveCount(0);

  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  const readerOrder = await topLevelLabels(page, "#reader-more-menu");

  // Compare only the labels both menus show; the reader keeps Reply, Archive,
  // and Trash in its toolbar, so those rows are absent there.
  const shared = [
    "Reply options",
    "Forward options",
    "Copy",
    "Print",
    "Save as .eml",
    "Conversation",
    "Sender and rules",
  ];
  const pick = (order: string[]) =>
    order.filter((label) => shared.includes(label));
  summary.rowTopLevel = rowOrder;
  summary.readerTopLevel = readerOrder;
  summary.sharedOrder = pick(rowOrder);
  expect(pick(rowOrder)).toEqual(shared);
  expect(pick(readerOrder)).toEqual(shared);
});

test("a mixed selection offers both Pin and Unpin", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Pin selected", exact: true })
    .click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  const labels = await page
    .locator('.app-menu [role="menuitem"]')
    .allTextContents();
  summary.mixedPinItems = labels.filter((label) => /pin selected/i.test(label));
  await expect(
    page.getByRole("menuitem", { name: "Pin selected", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Unpin selected", exact: true }),
  ).toBeVisible();
});
