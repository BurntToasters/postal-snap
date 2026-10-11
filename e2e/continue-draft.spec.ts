import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An open message can continue the unsent reply that answers it.
// 2. Several drafts continue the newest one.
// 3. A draft for another message, or a new message, leaves the note off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/continue-draft-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an open message can continue its unsent reply", async ({ page }) => {
  await page.goto("/?localMail=1&replyDraft=reply");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "unsent reply" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue draft" }).click();
  await expect(page.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "Family update",
  );
});

test("several drafts continue the newest one", async ({ page }) => {
  await page.goto("/?localMail=1&replyDraft=two");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(page.getByText("2 unsent drafts")).toBeVisible();
  await page.getByRole("button", { name: "Continue draft" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const call = window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
          (entry) => entry.command === "get_draft",
        );
        return call?.args.draftId;
      }),
    )
    .toBe("draft-2");
});

test("a draft for another message stays off this one", async ({ page }) => {
  await page.goto("/?localMail=1&replyDraft=other");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue draft" }),
  ).toHaveCount(0);
  await page.goto("/?localMail=1");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("button", { name: "Continue draft" }),
  ).toHaveCount(0);
});
