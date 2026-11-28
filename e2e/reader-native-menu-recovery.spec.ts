import { expect, test } from "./coverage-fixture";
import { attachArtifactsAfterEach, emitTauriEvent, ipcCalls } from "./ipc";
import { installMockIpc } from "./mock-ipc";

test.afterEach(attachArtifactsAfterEach);
test.beforeEach(async ({ page }) => installMockIpc(page));

// Failure modes covered through the native Tauri event bridge:
// 1. A menu action uses a stale reader selection or the wrong reply audience/body.
// 2. Replying with files mutates or mis-scopes the source attachment.
// 3. Flag and clear actions send the wrong selected message or color.
// 4. Subject rules lose the selected account, subject, or match field.
// 5. A save failure exposes its raw path or message details.

async function selectMessage(
  page: import("@playwright/test").Page,
  name: RegExp,
) {
  const row = page
    .getByRole("option", { name })
    .or(page.getByRole("treeitem", { name }));
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return row;
}

test("bare reply uses the current selection and leaves the body unquoted", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await selectMessage(page, /Library hours/);

  await emitTauriEvent(page, "menu-action", "reply-bare");

  const dialog = page.getByRole("dialog", { name: "Reply", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue(/jane@example.com/);
  await expect(dialog.getByLabel("Subject", { exact: true })).toHaveValue(
    "Re: Library hours",
  );
  await expect
    .poll(async () =>
      (await dialog.locator(".composer-editor").innerText()).trim(),
    )
    .toBe("");
});

test("reply to list addresses the list and quotes the selected message body", async ({
  page,
}) => {
  await page.goto("/?listMail=1");
  await selectMessage(page, /Weekend plans/);

  await emitTauriEvent(page, "menu-action", "reply-list");

  const dialog = page.getByRole("dialog", {
    name: "Reply to list",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("list@example.test");
  await expect(dialog.locator(".composer-editor")).toContainText(
    "Are we still meeting on Saturday?",
  );
});

test("reply with attachments ignores a stale result and keeps the source file", async ({
  page,
}) => {
  await page.goto("/?previewable=1&threadGap=1");
  await selectMessage(page, /Weekend plans/);
  await expect(
    page.locator(".reader-pane").getByText("family.png", { exact: true }),
  ).toBeVisible();

  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    const prepare = mock.handlers.prepare_reply_attachments;
    mock.handlers.prepare_reply_attachments = (args) => {
      if (Number(args.messageId) !== 10) return prepare(args);
      return new Promise((resolve) => {
        (window as Window & { __resolveReplyAttachmentRace?: () => void })[
          "__resolveReplyAttachmentRace"
        ] = () =>
          resolve([
            {
              token: "stale-reply-file",
              filename: "family.png",
              contentType: "image/png",
              inline: false,
              contentId: null,
              size: 128,
            },
          ]);
      });
    };
  });

  await emitTauriEvent(page, "menu-action", "reply-with-attachments");
  await expect
    .poll(
      async () =>
        (await ipcCalls(page)).filter(
          (call) => call.command === "prepare_reply_attachments",
        ).length,
    )
    .toBe(1);
  await selectMessage(page, /Library hours/);
  await page.evaluate(() => {
    (
      window as Window & { __resolveReplyAttachmentRace?: () => void }
    ).__resolveReplyAttachmentRace?.();
  });
  await expect(
    page.getByRole("dialog", { name: "Reply", exact: true }),
  ).toHaveCount(0);

  await emitTauriEvent(page, "menu-action", "reply-with-attachments");
  const dialog = page.getByRole("dialog", { name: "Reply", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue(/jane@example.com/);
  await expect(dialog.locator(".composer-editor")).toContainText(
    "Are we still meeting on Saturday?",
  );
  await expect(dialog.getByText(/family\.png/)).toBeVisible();
  await expect(
    page.locator(".reader-pane").getByText(/family\.png/),
  ).toBeVisible();

  const preparations = (await ipcCalls(page)).filter(
    (call) => call.command === "prepare_reply_attachments",
  );
  expect(preparations.map((call) => call.args)).toEqual([
    { accountId: "account-1", messageId: 10 },
    { accountId: "account-1", messageId: 30 },
  ]);
});

test("native color and clear actions follow the selected message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const row = await selectMessage(page, /Library hours/);

  await emitTauriEvent(page, "menu-action", "flag-color:3");
  await expect(row.locator(".star-mark")).toBeVisible();
  await emitTauriEvent(page, "menu-action", "clear-flag");
  await expect(row.locator(".star-mark")).toHaveCount(0);

  const calls = (await ipcCalls(page)).filter(
    (call) => call.command === "set_messages_flag_color",
  );
  expect(calls.map((call) => call.args)).toEqual([
    { accountId: "account-1", messageIds: [30], color: 3 },
    { accountId: "account-1", messageIds: [30], color: null },
  ]);
});

test("native subject-rule action seeds Settings and can be cancelled", async ({
  page,
}) => {
  await page.goto("/");
  await selectMessage(page, /Weekend plans/);

  await emitTauriEvent(page, "menu-action", "create-subject-rule");

  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel("Match by", { exact: true })).toHaveValue(
    "subject",
  );
  await expect(
    settings.getByLabel("Text to match", { exact: true }),
  ).toHaveValue("Weekend plans");
  const promptPromise = page.waitForEvent("dialog");
  const closePromise = settings
    .getByRole("button", { name: "Close settings" })
    .click();
  const prompt = await promptPromise;
  expect(prompt.type()).toBe("confirm");
  await prompt.dismiss();
  await closePromise;
  await expect(settings).toBeVisible();
  await expect(
    settings.getByLabel("Text to match", { exact: true }),
  ).toHaveValue("Weekend plans");
  expect(
    (await ipcCalls(page)).some(
      (call) => call.command === "create_filter_rule",
    ),
  ).toBe(false);
});

test("native save failure shows catalog text without backend details", async ({
  page,
}) => {
  await page.goto("/");
  await selectMessage(page, /Weekend plans/);
  const privateDetail =
    "/Users/private/mail/Weekend plans.eml could not save jane@example.com";
  await page.evaluate((detail) => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    mock.handlers.save_message_eml = () => {
      throw new Error(detail);
    };
  }, privateDetail);

  await emitTauriEvent(page, "menu-action", "save-eml");

  await expect(page.getByRole("alert")).toContainText(
    "Postal Snap could not finish that action. Try again.",
  );
  await expect(page.locator("body")).not.toContainText(privateDetail);
  const saved = (await ipcCalls(page)).find(
    (call) => call.command === "save_message_eml",
  );
  expect(saved?.args).toMatchObject({ accountId: "account-1", messageId: 10 });
});
