import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Cancelling the question leaves the draft in the list.
// 2. Discard removes that draft.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/discard-draft.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a draft can be discarded from the drafts list", async ({ page }) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const draft = page.getByRole("button", { name: /Family update/i });
  await draft.click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("menuitem", { name: "Discard" }).click();
  await expect(draft).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "delete_draft",
          ).length,
      ),
    )
    .toBe(0);

  await draft.click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Discard" }).click();
  await expect(draft).toHaveCount(0);
  await expect(page.getByText("No saved drafts on this device.")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "delete_draft",
          ).length,
      ),
    )
    .toBe(1);
});
