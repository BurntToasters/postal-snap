import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A sync stays on "Checking mail…" after the download count arrives.
// 2. The count is shown before mail is actually syncing.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/download-progress.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the mailbox shows how much mail is downloading", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(page.getByText("Downloading 3 of 10")).toHaveCount(0);
  const emit = (event: string, payload: Record<string, unknown>) =>
    page.evaluate(
      async ({ event, payload }) => {
        const internals = (
          window as typeof window & {
            __TAURI_INTERNALS__: {
              invoke: (
                command: string,
                args: Record<string, unknown>,
              ) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        await internals.invoke("plugin:event|emit", { event, payload });
      },
      { event, payload },
    );
  await emit("sync-progress", {
    accountId: "account-1",
    envelopesDone: 3,
    envelopesTotal: 10,
    bodiesDone: 1,
    bodiesTotal: 10,
    backfilling: true,
  });
  await expect(page.getByText("Downloading 3 of 10")).toHaveCount(0);
  await emit("sync-state", { accountId: "account-1", phase: "syncing" });
  await expect(page.getByText("Downloading 3 of 10")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "3");
});
