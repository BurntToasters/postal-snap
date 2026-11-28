import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import {
  attachArtifactsAfterEach,
  attachArtifacts,
  emitTauriEvent,
  ipcCommands,
} from "./ipc";

test.afterEach(attachArtifactsAfterEach);

test.beforeEach(async ({ page }) => installMockIpc(page));

// Failure modes covered here:
// 1. A count-only refresh that starts during a full account load must not
//    discard the full load's drafts when they arrive later.
// The delayed drafts response is released after 1.5 s; the count refresh
// runs first and must not cancel the full load.

const DRAFT_DELAY_MS = 1500;

test("a count refresh during a full load keeps the delayed drafts", async ({
  page,
}, testInfo) => {
  // Delays every list_drafts response, so the full load is still in flight.
  await page.addInitScript((delayMs: number) => {
    const scope = window as unknown as {
      __POSTAL_SNAP_MOCK__?: {
        handlers: Record<string, (args: unknown) => unknown>;
      };
    };
    const mock = scope.__POSTAL_SNAP_MOCK__;
    if (!mock) return;
    const original = mock.handlers.list_drafts;
    mock.handlers.list_drafts = (args) =>
      new Promise((resolve) =>
        window.setTimeout(() => resolve(original(args)), delayMs),
      );
  }, DRAFT_DELAY_MS);

  await page.goto("/?localMail=1");
  const drafts = page.getByRole("button", { name: /^Drafts/ });
  await expect(drafts).toBeVisible({ timeout: 20_000 });

  // The listener attaches asynchronously, so re-emit until a count load runs.
  await expect
    .poll(async () => {
      await emitTauriEvent(page, "folder-counts-changed", {
        accountId: "account-1",
      });
      return (await ipcCommands(page)).filter(
        (command) => command === "list_mailboxes",
      ).length;
    })
    .toBeGreaterThanOrEqual(2);

  await drafts.click();
  await expect(
    page.getByRole("button", { name: /Family update/i }),
  ).toBeVisible({ timeout: 10_000 });
  await attachArtifacts(page, testInfo, "mailbox-refresh-race");
});
