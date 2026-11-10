import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, attachIpcLog, ipcCommands } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

test.beforeEach(async ({ page }) => installMockIpc(page));

// Failure modes covered here:
// 1. A burst of folder count events reloads drafts, outbox and snoozed.
// 2. A burst of folder count events reloads the list once per burst.
// 3. A burst of message events reloads the message list once.
// The run ends with an IPC log per scenario.

const COALESCE_SETTLE_MS = 400;

type TauriInternals = {
  __TAURI_INTERNALS__: {
    invoke: (command: string, args: unknown) => Promise<unknown>;
  };
};

// Emits every event in one synchronous tick, as a Get Mail pass does.
async function emitBurst(
  page: Page,
  event: string,
  payload: unknown,
  count: number,
) {
  await page.evaluate(
    ([name, body, times]) => {
      const { __TAURI_INTERNALS__ } = window as unknown as TauriInternals;
      for (let index = 0; index < times; index += 1) {
        void __TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event: name,
          payload: body,
        });
      }
    },
    [event, payload, count] as const,
  );
}

async function commandsSince(page: Page, start: number): Promise<string[]> {
  return (await ipcCommands(page)).slice(start);
}

async function openMailbox(page: Page) {
  await page.goto("/?multiAccount=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(COALESCE_SETTLE_MS);
}

test("ten folder count events reload only the mailbox counts once", async ({
  page,
}, testInfo: TestInfo) => {
  await openMailbox(page);
  const start = (await ipcCommands(page)).length;

  await emitBurst(
    page,
    "folder-counts-changed",
    { accountId: "account-1" },
    10,
  );
  await expect
    .poll(async () =>
      (await commandsSince(page, start)).includes("list_mailboxes"),
    )
    .toBe(true);
  await page.waitForTimeout(COALESCE_SETTLE_MS);

  const after = await commandsSince(page, start);
  expect(after.filter((command) => command === "list_mailboxes")).toHaveLength(
    1,
  );
  for (const command of ["list_drafts", "list_outbox", "list_snoozed"]) {
    expect(after).not.toContain(command);
  }
  expect(after).not.toContain("list_messages");
  await attachIpcLog(page, testInfo, "counts-burst");
});

test("ten message events reload the message list once", async ({
  page,
}, testInfo: TestInfo) => {
  await openMailbox(page);
  const start = (await ipcCommands(page)).length;

  await emitBurst(
    page,
    "message-changed",
    { accountId: "account-1", messageId: null, kind: "synced" },
    10,
  );
  await expect
    .poll(async () =>
      (await commandsSince(page, start)).includes("list_messages"),
    )
    .toBe(true);
  await page.waitForTimeout(COALESCE_SETTLE_MS);

  const after = await commandsSince(page, start);
  expect(after.filter((command) => command === "list_messages")).toHaveLength(
    1,
  );
  await attachIpcLog(page, testInfo, "message-burst");
});
