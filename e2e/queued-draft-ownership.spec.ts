import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// The native SQLite regressions prove ownership. This browser flow proves the
// scheduled-send and Undo/Edit path still uses the restored draft returned by IPC.
test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/queued-draft-ownership.png";
  const screenshot = await page.screenshot({ path });
  await testInfo.attach("queued-draft-ownership.png", {
    body: screenshot,
    contentType: "image/png",
  });
  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  await testInfo.attach("ipc-evidence.json", {
    body: JSON.stringify(calls, null, 2),
    contentType: "application/json",
  });
});

test("scheduled send leaves Drafts and Undo opens one restored copy", async ({
  page,
}) => {
  await page.goto("/?localMail=1&undoSendOff=1");
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    let saved: Record<string, unknown> | undefined;
    let queued: Record<string, unknown> | undefined;
    const summary = (draft: Record<string, unknown>, id: string) => ({
      id,
      accountId: draft.accountId,
      recipients: Array.isArray(draft.to) ? draft.to.join(", ") : "",
      subject: draft.subject,
      updatedAt: new Date().toISOString(),
      syncState: "localPending",
      syncDetail: null,
      preview: "",
      attachmentCount: Array.isArray(draft.attachments)
        ? draft.attachments.length
        : 0,
      fromAddress: "",
      sourceMessageId: null,
      sourceKind: null,
    });

    mock.handlers.list_drafts = () =>
      saved && !queued ? [summary(saved, String(saved.id))] : [];
    mock.handlers.save_draft = (args) => {
      const draft = { ...(args.draft as Record<string, unknown>) };
      const id = String(draft.id ?? "draft-source");
      if (queued && id === queued.id)
        throw new Error("This draft is already queued.");
      draft.id = id;
      saved = draft;
      return { id, syncState: "localPending" };
    };
    mock.handlers.send_message = (args) => {
      queued = { ...(args.draft as Record<string, unknown>) };
      return {
        id: "outbox-owned",
        state: "scheduled",
        detail: "Held for review. Undo anytime before it sends.",
      };
    };
    mock.handlers.list_outbox = () =>
      queued
        ? [
            {
              id: "outbox-owned",
              accountId: mock.account.id,
              recipients: "lee@example.com",
              subject: queued.subject,
              state: "scheduled",
              preview: "",
              attachmentCount: 0,
              detail: "Held for review. Undo anytime before it sends.",
              createdAt: new Date().toISOString(),
              sendAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            },
          ]
        : [];
    mock.handlers.restore_outbox = () => {
      if (!queued) throw new Error("Queued message not found.");
      const restored = { ...queued, id: "draft-restored", sendAt: null };
      queued = undefined;
      saved = restored;
      (
        window as unknown as { __queuedRestoredId?: string }
      ).__queuedRestoredId = String(restored.id);
      return restored;
    };
  });

  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Owned draft");
  await page.getByLabel("Message body").pressSequentially("Keep this copy.");
  await page.keyboard.press("Meta+s");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "save_draft",
          ).length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.getByRole("button", { name: /Owned draft/ })).toHaveCount(
    0,
  );
  await expect(page.getByText("No saved drafts on this device.")).toBeVisible();

  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Owned draft")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#composer-subject")).toHaveValue("Owned draft");

  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  expect(calls.some((call) => call.command === "restore_outbox")).toBe(true);
  expect(calls.some((call) => call.command === "retry_outbox")).toBe(false);
  const restoredId = await page.evaluate(
    () =>
      (window as unknown as { __queuedRestoredId?: string }).__queuedRestoredId,
  );
  expect(restoredId).toBe("draft-restored");
});
