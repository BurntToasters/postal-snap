import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Remove all files drops every attached file and releases them.
// 2. One attached file does not offer that action.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/compose-remove-files-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("remove all files clears every attachment", async ({ page }) => {
  await page.goto("/?pickPair=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  const files = page.locator(".compose-attachments");
  await expect(files).toContainText("budget.pdf");
  await expect(files).toContainText("notes.txt");
  await page.getByRole("button", { name: "Remove all files" }).click();
  await expect(files).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const call = window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
          (entry) => entry.command === "release_compose_attachments",
        );
        return call?.args.tokens;
      }),
    )
    .toEqual(["picked-token-1", "picked-token-2"]);
});

test("one attached file has no remove-all action", async ({ page }) => {
  await page.goto("/?pickFile=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "budget.pdf",
  );
  await expect(
    page.getByRole("button", { name: "Remove all files" }),
  ).toHaveCount(0);
});
