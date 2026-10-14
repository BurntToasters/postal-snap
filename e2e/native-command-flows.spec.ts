import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Missing command mocks must not turn user actions into silent errors.
// These flows verify the IPC boundary; native TLS, dialogs, and file writes
// remain covered by Rust/fixture tests and packaged-app manual checks.
test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});
test.afterEach(async ({ page }, testInfo) => {
  await attachIpcLog(page, testInfo);
});

async function commandArgs(
  page: import("@playwright/test").Page,
  command: string,
) {
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter((call) => call.command === command)
          .length,
    )
    .toBeGreaterThan(0);
  return (await recordedCalls(page)).find((call) => call.command === command)
    ?.args;
}

for (const all of [false, true]) {
  test(
    all ? "saves all message files" : "saves one message file",
    async ({ page }) => {
      await page.goto("/?previewable=1&filePair=1");
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      const button = page.getByRole("button", {
        name: all ? "Save all files" : "Download file: family.png",
        exact: true,
      });
      await button.click();
      const args = await commandArgs(
        page,
        all ? "save_all_attachments" : "save_attachment",
      );
      expect(args).toMatchObject({ accountId: "account-1", messageId: 10 });
      if (!all)
        expect(args).toMatchObject({
          attachmentId: "attach-1",
          suggestedFilename: "family.png",
        });
      await expect(button).toBeEnabled();
      await expect(page.getByRole("alert")).toHaveCount(0);
    },
  );
}

test("forwards the open message as an attached MIME copy", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Forward as attachment", exact: true })
    .click();
  expect(await commandArgs(page, "prepare_forwarded_message")).toMatchObject({
    accountId: "account-1",
    messageId: 10,
  });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove Weekend plans.eml", exact: true }),
  ).toBeVisible();
});

test("copies one message without removing its source", async ({ page }) => {
  await page.goto("/?manyFolders=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Copy to Receipts", exact: true })
    .click();
  expect(await commandArgs(page, "copy_message_to_mailbox")).toMatchObject({
    accountId: "account-1",
    messageId: 10,
    destinationMailboxId: 8,
  });
  await expect(
    page.getByRole("heading", { name: "Weekend plans", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("tests a saved account through the native boundary", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  const manage = page.getByRole("button", { name: "Manage Sam", exact: true });
  await manage.click();
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  expect(await commandArgs(page, "test_saved_account")).toMatchObject({
    accountId: "account-1",
  });
  await expect(page.getByText(/Connected and in sync/)).toBeVisible();
});

test("clears downloads only after confirmation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  const clear = page.getByRole("button", {
    name: "Clear downloaded mail",
    exact: true,
  });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await clear.click();
  expect(
    (await recordedCalls(page)).some(
      (call) => call.command === "clear_downloaded_mail",
    ),
  ).toBe(false);
  page.once("dialog", (dialog) => void dialog.accept());
  await clear.click();
  await commandArgs(page, "clear_downloaded_mail");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("native reduced transparency keeps the workspace opaque", async ({
  page,
}) => {
  await page.goto("/?nativeReducedTransparency=1");
  await commandArgs(page, "accessibility_reduce_transparency");
  await expect(page.locator("html")).toHaveAttribute(
    "data-reduce-transparency",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-fx",
    "opaque",
  );
});
