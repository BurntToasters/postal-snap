import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Chosen files from one message are saved together, and the others stay put.
// 2. A message with one file has no choose boxes.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/save-chosen-files-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("chosen files are saved together", async ({ page }) => {
  await page.goto("/?previewable=1&filePair=1");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await expect(
    page.getByRole("button", { name: /Save \d+ chosen/ }),
  ).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Choose notes.txt" }).check();
  await page.getByRole("button", { name: "Save 1 chosen file" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const call = window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
          (entry) => entry.command === "save_chosen_attachments",
        );
        return call?.args.attachmentIds;
      }),
    )
    .toEqual(["attach-2"]);
  await expect(page.getByText("family.png")).toBeVisible();
});

test("a message with one file has no choose boxes", async ({ page }) => {
  await page.goto("/?previewable=1");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await expect(page.getByText("family.png")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Choose / })).toHaveCount(0);
});
