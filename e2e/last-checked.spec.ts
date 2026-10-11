import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An idle account with a successful check names that time.
// 2. A check that is still running does not claim that time.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/last-checked.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the mailbox says when mail was last checked", async ({ page }) => {
  await page.goto("/");
  const checked = new Date().toISOString();
  await page.evaluate(async (when) => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
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
      event: "sync-state",
      payload: {
        accountId: mock.account.id,
        phase: "idle",
        lastSuccessAt: when,
      },
    });
  }, checked);
  await expect(page.getByRole("status")).toContainText("Mail is up to date.");
  await expect(page.getByRole("status")).toContainText(/Checked /);

  await page.evaluate(async () => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
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
      event: "sync-state",
      payload: {
        accountId: mock.account.id,
        phase: "syncing",
        detail: "Checking mail…",
      },
    });
  });
  await expect(page.getByRole("status")).toHaveText("Checking mail…");
});
