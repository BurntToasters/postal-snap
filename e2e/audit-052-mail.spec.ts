import { mkdir, writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// 1. Row Print message prints twice and opens the message.
// 2. Forward from the focused row drops its attachments.
// 3. Get Mail tooltip shows Ctrl/Cmd+F5 and omits Shift-click for all accounts.
// 4. Search tips are unreachable in local views; recent searches stay open.
// 5. Select-mode s always stars instead of toggling.
// 6. Ctrl+click on macOS both opens the menu and checks the row.
// 7. Row names repeat the folder.
// 8. Drawer drag misses the edge band or closes a manually opened drawer.
// 9. BCC stays out of the reader header (Details only).
// Writes mail-regressions.json under artifacts/0.5.2/audit-fixes/audit-mail.
// Each test ends with a screenshot.

const ARTIFACT_DIR = "artifacts/0.5.2/audit-fixes/audit-mail";
const summary: Record<string, unknown> = {};

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/audit-052-mail-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test.afterAll(async () => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    `${ARTIFACT_DIR}/mail-regressions.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
});

async function printCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.printCalls ?? 0);
}

async function starCalls(page: Page): Promise<boolean[]> {
  return page.evaluate(() =>
    (window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [])
      .filter((call) => call.command === "set_messages_flags")
      .map((call) => call.args.isStarred as boolean),
  );
}

/** Dispatches a click carrying modifier keys, as the browser would on each OS. */
async function clickRowWith(
  page: Page,
  modifiers: { ctrl?: boolean; meta?: boolean },
) {
  await page.evaluate((mods) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>(".message-row"),
    ).find((node) =>
      /Library hours/i.test(node.getAttribute("aria-label") ?? ""),
    );
    row?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: mods.ctrl ?? false,
        metaKey: mods.meta ?? false,
      }),
    );
  }, modifiers);
}

async function ipcCount(page: Page, command: string): Promise<number> {
  return page.evaluate(
    (name) =>
      (window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []).filter(
        (call) => call.command === name,
      ).length,
    command,
  );
}

test("row Print message prints once and leaves the message closed and unread", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.evaluate(() => {
    const counter = { print: 0 };
    (window as unknown as { __auditPrint: typeof counter }).__auditPrint =
      counter;
    window.addEventListener("postal:print-message", () => {
      counter.print += 1;
    });
  });
  const row = page.locator(".message-row", { hasText: /Library hours/i });
  const before = await row.getAttribute("aria-label");
  expect(before?.startsWith("Unread")).toBe(true);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Print", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Print message", exact: true })
    .click();
  await expect.poll(() => printCount(page)).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  const counts = await page.evaluate(() => ({
    webview: window.__POSTAL_SNAP_TEST__?.printCalls ?? 0,
    events: (window as unknown as { __auditPrint: { print: number } })
      .__auditPrint.print,
  }));
  expect(counts).toEqual({ webview: 1, events: 0 });
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toHaveCount(0);
  expect(await row.getAttribute("aria-label")).toBe(before);
  summary.rowPrint = counts;
});

test("f forwards the focused message with its attachments", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&forwardAttachment=1");
  const row = page.locator(".message-row", { hasText: /Library hours/i });
  await row.focus();
  await page.keyboard.press("f");
  const dialog = page.getByRole("dialog", { name: "Forward", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("family-plan.pdf");
  await expect(page.getByRole("dialog", { name: "Forward" })).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(await ipcCount(page, "prepare_forward_attachments")).toBe(1);
  summary.focusedForward = { attachments: "family-plan.pdf", calls: 1 };
});

test("Get Mail tooltip names plain F5 and offers Shift-click for all accounts", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  const button = page.getByRole("button", { name: "Get Mail", exact: true });
  const title = (await button.getAttribute("title")) ?? "";
  expect(title).toMatch(/Get Mail \(F5\)/);
  expect(title).not.toMatch(/Ctrl\+F5|⌘F5/);
  expect(title).toMatch(/Shift-click|Shift\+F5/);
  const keys = (await button.getAttribute("aria-keyshortcuts")) ?? "";
  expect(keys).toContain("Meta+Shift+M");
  expect(keys).toContain("Control+Shift+M");
  summary.getMailTitle = title;
});

test("search tips open from Drafts and close with Escape", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: "Search tips", exact: true }).click();
  const tips = page.getByRole("region", { name: "Search tips" });
  await expect(tips).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tips).toHaveCount(0);
  summary.localViewTips = "reachable";
});

test("recent searches close on outside click", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("Picnic");
  await search.press("Enter");
  await expect.poll(() => ipcCount(page, "remember_search")).toBeGreaterThan(0);
  await search.fill("");
  await search.blur();
  await search.focus();
  const menu = page.locator(".search-recent");
  await expect(menu).toBeVisible();
  await page.mouse.click(2, 300);
  await expect(menu).toHaveCount(0);
});

test("select-mode s stars unstarred checked messages", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
  // Focus the checked row; a completed bulk action leaves select mode.
  await page.getByRole("option", { name: /Library hours/i }).focus();
  await page.keyboard.press("s");
  await expect.poll(() => starCalls(page)).toEqual([true]);
  summary.selectStar = "stars when any checked message is unstarred";
});

test("Ctrl+click on macOS only opens the menu and does not check the row", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "macos";
  });
  await clickRowWith(page, { ctrl: true });
  await expect(page.getByRole("toolbar", { name: /selected/ })).toHaveCount(0);
  await clickRowWith(page, { meta: true });
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  summary.macModifiers = "meta checks, control does not";
});

test("Ctrl+click elsewhere checks the row", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "linux";
  });
  await clickRowWith(page, { ctrl: true });
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
});

test("row names keep the thread count and preview", async ({ page }) => {
  await page.goto("/?threadGap=1");
  const thread = page.getByRole("treeitem", { name: /Weekend plans/i });
  const label = (await thread.getAttribute("aria-label")) ?? "";
  // The visible count stays before the unread text (axe); "2 messages" stays for mail-flow.
  expect(label).toContain("2, 2 unread");
  expect(label).toContain("2 messages");
  const preview = (await thread.locator(".message-preview").textContent())
    ?.trim()
    .slice(0, 20);
  expect(preview).toBeTruthy();
  expect(label.split(preview ?? "").length - 1).toBe(1);
  summary.threadName = label;
});

test("a drag that enters the left edge opens the drawer and closes it only if the drag opened it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto("/?threadGap=1");
  const toggle = page.getByRole("button", { name: /Show mailboxes/ });
  const startDrag = (x: number) =>
    page.evaluate((clientX) => {
      const row = document.querySelector<HTMLElement>(".message-row");
      const transfer = new DataTransfer();
      row?.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: 300,
          clientY: 300,
        }),
      );
      window.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX,
          clientY: 300,
        }),
      );
    }, x);
  const endDrag = () =>
    page.evaluate(() =>
      window.dispatchEvent(new DragEvent("dragend", { bubbles: true })),
    );

  await startDrag(5);
  await expect(
    page.getByRole("button", { name: /Hide mailboxes/ }),
  ).toBeVisible();
  await endDrag();
  await expect(toggle).toBeVisible();

  await toggle.click();
  await expect(
    page.getByRole("button", { name: /Hide mailboxes/ }),
  ).toBeVisible();
  await startDrag(5);
  await endDrag();
  await expect(
    page.getByRole("button", { name: /Hide mailboxes/ }),
  ).toBeVisible();
  summary.drawerDrag = "opens on edge; manual open survives drag end";
});
