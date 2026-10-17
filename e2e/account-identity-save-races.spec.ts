import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A delayed display-name save overwrites a newer edit made while saving.
// 2. A delayed Reply-To save overwrites a newer edit made while saving.

async function openIdentity(page: Page) {
  await installMockIpc(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
}

function delayNextSave(
  page: Page,
  command: "update_account_display_name" | "update_account_reply_to",
  controlKey: string,
) {
  return page.evaluate(
    ({ command, controlKey }) => {
      const browser = window as unknown as {
        __POSTAL_SNAP_MOCK__?: {
          handlers: Record<string, (args: Record<string, unknown>) => unknown>;
        };
        [key: string]: unknown;
      };
      const mock = browser.__POSTAL_SNAP_MOCK__;
      if (!mock) throw new Error("Mock IPC was not installed");
      const original = mock.handlers[command];
      if (!original) throw new Error(`Mock handler missing: ${command}`);
      const control: { pending: boolean; release?: () => void } = {
        pending: false,
      };
      (browser as Record<string, unknown>)[controlKey] = control;
      mock.handlers[command] = (args) =>
        new Promise((resolve, reject) => {
          control.pending = true;
          control.release = () => {
            control.pending = false;
            mock.handlers[command] = original;
            void Promise.resolve(original(args)).then(resolve, reject);
          };
        });
    },
    { command, controlKey },
  );
}

async function waitForPending(page: Page, controlKey: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          (window as unknown as Record<string, { pending?: boolean }>)[key]
            ?.pending,
        controlKey,
      ),
    )
    .toBe(true);
}

async function releaseSave(page: Page, controlKey: string) {
  await page.evaluate((key) => {
    const control = (
      window as unknown as Record<string, { release?: () => void }>
    )[key];
    if (!control?.release) throw new Error("No delayed save to release");
    control.release();
  }, controlKey);
}

test("delayed display-name save preserves newer edits", async ({ page }) => {
  await openIdentity(page);
  const input = page.getByLabel("Name on mail you send");
  await input.fill("First saved name");
  await delayNextSave(page, "update_account_display_name", "__nameRace__");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await waitForPending(page, "__nameRace__");
  await input.fill("New unsaved name");
  await releaseSave(page, "__nameRace__");
  await expect(page.getByText("Name saved.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("New unsaved name");

  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "update_account_display_name",
          ).length,
      ),
    )
    .toBe(2);
  const calls = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
      (call) => call.command === "update_account_display_name",
    ),
  );
  expect(calls?.[1]?.args).toMatchObject({ displayName: "New unsaved name" });
});

test("delayed Reply-To save preserves newer edits", async ({ page }) => {
  await openIdentity(page);
  const input = page.getByLabel("Reply-To address");
  await input.fill("first@example.test");
  await delayNextSave(page, "update_account_reply_to", "__replyRace__");
  await page
    .getByRole("button", { name: "Save Reply-To", exact: true })
    .click();
  await waitForPending(page, "__replyRace__");
  await input.fill("newer@example.test");
  await releaseSave(page, "__replyRace__");
  await expect(
    page.getByText("Reply-To address saved.", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("newer@example.test");

  await page
    .getByRole("button", { name: "Save Reply-To", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "update_account_reply_to",
          ).length,
      ),
    )
    .toBe(2);
  const calls = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
      (call) => call.command === "update_account_reply_to",
    ),
  );
  expect(calls?.[1]?.args).toMatchObject({ replyTo: "newer@example.test" });
});
