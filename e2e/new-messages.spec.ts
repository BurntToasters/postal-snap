import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. New mail that arrives while the list is scrolled down offers a way back.
// 2. Choosing it returns to the top, where that message is.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/new-messages.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("new mail offers a way back to the top of the list", async ({ page }) => {
  await page.goto("/?longList=1");
  const list = page.locator(".message-list");
  await expect(page.locator("[data-message-id='200']")).toBeVisible();
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await page.evaluate(async () => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
    mock.arrivedMessages = [
      {
        ...mock.summary,
        id: 900,
        uid: 900,
        messageId: "<arrived@example.com>",
        subject: "Just arrived",
        receivedAt: "2026-08-19T12:00:00Z",
        isRead: false,
        threadRoot: null,
      },
    ];
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
    await internals.invoke("plugin:event|emit", {
      event: "message-changed",
      payload: { accountId: mock.account.id, kind: "synced" },
    });
  });
  await page.getByRole("button", { name: "New messages" }).click();
  await expect(page.locator("[data-message-id='900']")).toBeVisible();
  await expect(page.getByRole("button", { name: "New messages" })).toHaveCount(
    0,
  );
});
