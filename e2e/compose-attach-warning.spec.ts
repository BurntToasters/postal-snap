import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message that says "attached" with no file sends without a warning.
// 2. The warning fires for quoted reply text or after the "-- " signature.
// 3. Files already attached still trigger the warning.
// 4. The dialog is not modal: Tab escapes it, or Escape sends or closes it.
// 5. "Send anyway" drops the scheduled time; "Add attachment" sends.
// 6. Messages with no keyword are held up by a dialog.
// 7. Dialog lacks a name or the safe choice is not focused first.
// The run ends with a screenshot and the recorded IPC calls.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

async function startMessage(page: Page, path: string, body: string) {
  await page.goto(path);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Numbers");
  await page.getByLabel("Message body").pressSequentially(body);
}

const dialog = (page: Page) =>
  page.getByRole("alertdialog", { name: "Send without an attachment?" });

async function sends(page: Page) {
  return (await recordedCalls(page)).filter(
    (call) => call.command === "send_message",
  );
}

test("warns before sending a mentioned attachment with nothing attached", async ({
  page,
}, testInfo) => {
  await startMessage(page, "/", "Please see the attached budget.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText(
    "mentions an attachment, but nothing is attached",
  );
  await expect(
    dialog(page).getByRole("button", { name: "Add attachment" }),
  ).toBeFocused();
  expect(await sends(page)).toHaveLength(0);

  // Focus stays inside the dialog.
  await page.keyboard.press("Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Send anyway" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Add attachment" }),
  ).toBeFocused();

  // Escape only closes the dialog: nothing is sent and the draft stays open.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".composer-window")).toBeVisible();
  expect(await sends(page)).toHaveLength(0);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Send anyway" }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const calls = await sends(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toMatchObject({
    draft: { attachments: [], bodyFormat: "html" },
  });

  await page.screenshot({ path: "test-results/compose-attach-warning.png" });
  await testInfo.attach("final.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await attachIpcLog(page, testInfo);
});

test("Add attachment opens the picker and then sends without asking", async ({
  page,
}) => {
  await startMessage(page, "/?pickFile=1", "I am attaching the budget.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Add attachment" }).click();

  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".compose-attachments")).toContainText(
    "budget.pdf",
  );
  const calls = await recordedCalls(page);
  expect(calls.filter((call) => call.command === "choose_attachments")).toEqual(
    [
      {
        command: "choose_attachments",
        args: { accountId: expect.any(String), inline: false },
      },
    ],
  );
  expect(await sends(page)).toHaveLength(0);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  expect(await sends(page)).toHaveLength(1);
  expect(await sends(page)).toMatchObject([
    { args: { draft: { attachments: [{ filename: "budget.pdf" }] } } },
  ]);
});

test("scheduled sends get the same warning and keep their time", async ({
  page,
}) => {
  await startMessage(page, "/", "Enclosed is the schedule.");
  await page.getByRole("button", { name: "Send options" }).click();
  await page.getByRole("menuitem", { name: "Send tomorrow at 8 AM" }).click();
  await expect(dialog(page)).toBeVisible();
  expect(await sends(page)).toHaveLength(0);
  await dialog(page).getByRole("button", { name: "Send anyway" }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const [call] = await sends(page);
  const draft = (call.args as { draft: { sendAt?: string } }).draft;
  expect(Date.parse(draft.sendAt ?? "")).toBeGreaterThan(Date.now());
});

test("ignores quoted text and the signature", async ({ page }) => {
  // "> " starts a quote; text after the "-- " marker is the signature.
  await startMessage(page, "/", "> As you attached earlier");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Thanks");
  await page.keyboard.press("Enter");
  await page.keyboard.type("-- ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Sent with the attached signature card");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  expect(await sends(page)).toHaveLength(1);
});

test("no keyword and existing attachments send without a dialog", async ({
  page,
}) => {
  await startMessage(page, "/", "Lunch on Friday?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  expect(await sends(page)).toHaveLength(1);
  await expect(dialog(page)).toHaveCount(0);

  await page.goto("/?pickFile=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByLabel("Message body").pressSequentially("See attached.");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "budget.pdf",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
});
