import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes for leftover attachment folders in Storage settings:
// 1. Leftovers exist but no notice appears, so a failed removal stays silent.
// 2. A clean library still shows the notice, which causes a false alarm.
// 3. Try again succeeds but the notice stays until the app restarts.
// 4. Try again still fails but the notice disappears, hiding a real leftover.
// 5. The notice shows a path or account detail instead of plain text.
// 6. The Try again control is unnamed or under 44px in comfortable density.
// 7. The notice overflows or hides its control at compact density and 200% text.

const NOTICE =
  "Some removed account files could not be deleted. Restart Postal Snap to try again.";

async function openStorage(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = `test-results/attachment-leftovers-${name}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
}

test("shows a plain leftover notice in Storage settings", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.goto("/?attachmentLeftovers=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  const notice = page.getByRole("status").filter({ hasText: NOTICE });
  await expect(notice).toBeVisible();
  await expect(notice.locator("p")).toHaveText(NOTICE);
  await expect(notice).not.toContainText(/[\\/]/);
  const retry = notice.getByRole("button", { name: "Try again", exact: true });
  const box = await retry.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await capture(page, testInfo, "comfortable");
  await attachIpcLog(page, testInfo);
});

test("omits the leftover notice when nothing was left behind", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await openStorage(page);
  await expect(page.getByText(NOTICE, { exact: true })).toHaveCount(0);
  await expect(page.locator(".storage-card")).toBeVisible();
  await capture(page, testInfo, "clean");
  await attachIpcLog(page, testInfo);
});

test("Try again clears the notice once leftovers are removed", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.goto("/?attachmentLeftovers=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  await expect(page.getByText(NOTICE, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(NOTICE, { exact: true })).toHaveCount(0);
  expect((await recordedCalls(page)).map((call) => call.command)).toContain(
    "retry_attachment_cleanup",
  );
  await attachIpcLog(page, testInfo);
});

test("Try again keeps the notice while a folder is still stuck", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.goto("/?attachmentLeftovers=1&attachmentLeftoversStuck=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(NOTICE, { exact: true })).toBeVisible();
  await attachIpcLog(page, testInfo);
});

for (const density of ["comfortable", "compact"]) {
  for (const scale of [1, 2]) {
    test(`leftover notice fits ${density} at ${scale * 100}% text`, async ({
      page,
    }, testInfo) => {
      await installMockIpc(page);
      await page.goto(
        `/?attachmentLeftovers=1&density=${density}&scale=${scale}`,
      );
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Storage", exact: true }).click();
      const retry = page
        .getByRole("status")
        .filter({ hasText: NOTICE })
        .getByRole("button", { name: "Try again", exact: true });
      await expect(retry).toBeVisible();
      await expect(retry).toBeInViewport();
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      expect(fits).toBe(true);
      await capture(page, testInfo, `${density}-${scale * 100}`);
    });
  }
}
