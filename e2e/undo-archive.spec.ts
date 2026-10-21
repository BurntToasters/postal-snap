import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section A):
// A3. A notice with Undo stays open while the pointer or keyboard focus is on it.
// A13. Folder counts return to their pre-move values after Undo.
// A16. Delete Forever is not deferred and offers no Undo.
// A17 (single move). The undo window commits exactly once, on timeout.

const VIEWPORT = { width: 1280, height: 900 };
const combos = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

async function openInbox(page: Page, query: string) {
  await installMockIpc(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(`/?${query}`);
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
}

async function calls(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === name,
      ) ?? [],
    command,
  );
}

async function lastCall(page: Page, command: string) {
  const all = await calls(page, command);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

async function expectAxeClean(page: Page) {
  const scan = await new AxeBuilder({ page })
    .include(".notice-region")
    .analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function archiveWeekendPlans(page: Page) {
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("e");
  await expect(row).toBeHidden();
  return page.locator(".notice", { hasText: "Archived 1 message." });
}

for (const { density, scale } of combos) {
  const label = `${density} ${scale * 100}%`;
  const query = `density=${density}&scale=${scale}`;
  const slug = `${density}-${scale * 100}`;

  test(`archive then Undo restores the message and folder counts, ${label}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await openInbox(page, query);
    const row = page.getByRole("option", { name: /Weekend plans/i });
    const notice = await archiveWeekendPlans(page);
    await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: /^Archive/ })).toContainText(
      "1",
    );
    await expect(
      page.getByRole("button", { name: /^Inbox/ }),
    ).not.toContainText("1");

    await notice.getByRole("button", { name: "Undo" }).click();
    await expect(row).toBeVisible();
    await expect(page.getByRole("button", { name: /^Inbox/ })).toContainText(
      "1",
    );
    await expect(
      page.getByRole("button", { name: /^Archive/ }),
    ).not.toContainText("1");
    await expect(
      page.locator(".notice", { hasText: "Message restored." }),
    ).toBeVisible();

    const moved = await lastCall(page, "move_message");
    const undone = await lastCall(page, "undo_deferred");
    expect(undone.args).toMatchObject({
      accountId: "account-1",
      undoToken: moved.args.undoToken,
    });
    expect(await calls(page, "commit_deferred")).toHaveLength(0);
    await expectAxeClean(page);
    await attachArtifacts(page, testInfo, `undo-archive-${slug}`);
  });

  test(`a notice waits while hovered or focused, then commits once, ${label}`, async ({
    page,
  }, testInfo: TestInfo) => {
    test.setTimeout(90_000);
    await openInbox(page, query);
    const notice = await archiveWeekendPlans(page);
    await expect(notice).toBeVisible();

    await notice.hover();
    await page.waitForTimeout(9_500);
    await expect(notice).toBeVisible();
    expect(await calls(page, "commit_deferred")).toHaveLength(0);

    await page.mouse.move(0, 0);
    const undo = notice.getByRole("button", { name: "Undo" });
    await undo.focus();
    await page.waitForTimeout(9_500);
    await expect(notice).toBeVisible();
    expect(await calls(page, "commit_deferred")).toHaveLength(0);

    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(notice).toHaveCount(0, { timeout: 12_000 });
    await page.waitForTimeout(1_000);
    const committed = await calls(page, "commit_deferred");
    const moved = await lastCall(page, "move_message");
    expect(committed).toHaveLength(1);
    expect(committed[0].args).toMatchObject({
      accountId: "account-1",
      undoToken: moved.args.undoToken,
    });
    expect(await calls(page, "undo_deferred")).toHaveLength(0);
    await attachArtifacts(page, testInfo, `undo-timeout-${slug}`);
  });

  test(`Delete Forever is not undoable and shows no Undo, ${label}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await installMockIpc(page);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`/?inTrash=1&${query}`);
    await page.getByRole("button", { name: /^Trash/ }).click();
    const row = page.getByRole("option", { name: /Weekend plans/i });
    await row.click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.keyboard.press("Delete");
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => (await calls(page, "delete_trash_messages")).length)
      .toBe(1);
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
    expect(await calls(page, "move_message")).toHaveLength(0);
    expect(await calls(page, "undo_deferred")).toHaveLength(0);
    await attachArtifacts(page, testInfo, `delete-forever-${slug}`);
  });
}

test("moving to Trash offers Undo with trash wording", async ({
  page,
}, testInfo) => {
  await openInbox(page, "density=comfortable&scale=1");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.click();
  await page.keyboard.press("ControlOrMeta+Backspace");
  await expect(row).toBeHidden();
  const notice = page.locator(".notice", {
    hasText: "Moved 1 message to Trash.",
  });
  await expect(notice.getByRole("button", { name: "Undo" })).toBeVisible();
  await attachArtifacts(page, testInfo, "undo-trash");
});
