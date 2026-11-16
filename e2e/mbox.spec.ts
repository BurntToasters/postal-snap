import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, attachIpcLog, ipcCalls } from "./ipc";

// Failure modes covered here:
// FM1. Export from the folder menu shows progress from events, then result counts.
// FM2. Cancel sends cancel_mbox_operation with the operationId from progress.
// FM3. A dismissed save dialog shows no notice and no progress.
// FM4. A limitExceeded error shows its authored text in the alert region.
// FM5. Import refreshes the mailbox list after it succeeds.
// FM6. No notice text or mbox IPC argument carries a path-like string.
// FM7. The folder menu's Export item is reachable from the keyboard.
// FM8. The command palette lists Export mailbox for the current folder.

test.afterEach(attachArtifactsAfterEach);
test.beforeEach(async ({ page }) => installMockIpc(page));

const inboxRow = (page: Page) => page.getByRole("button", { name: /^Inbox/ });
const progressBar = (page: Page) => page.getByRole("progressbar");
const notices = (page: Page) => page.locator(".notice-region");

type Recorded = { command: string; args: unknown };

async function mboxCalls(page: Page): Promise<Recorded[]> {
  const calls = (await ipcCalls(page)) as Recorded[];
  return calls.filter((call) =>
    ["export_mailbox_mbox", "import_mbox", "cancel_mbox_operation"].includes(
      call.command,
    ),
  );
}

async function exportFromInboxMenu(page: Page) {
  await inboxRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Export mailbox/ }).click();
}

test("FM1 export from the folder menu shows progress, then counts", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?folderTotal=400&mboxSkipped=1");
  await exportFromInboxMenu(page);
  await expect(progressBar(page)).toBeVisible();
  await expect(progressBar(page)).toHaveAttribute("aria-valuemax", "400");
  await expect
    .poll(async () =>
      Number(await progressBar(page).getAttribute("aria-valuenow")),
    )
    .toBeGreaterThan(0);
  await expect(
    notices(page).getByText("Exported 398 messages. 2 messages were skipped."),
  ).toBeVisible({ timeout: 15_000 });
  await expect(progressBar(page)).toHaveCount(0);
  const calls = await mboxCalls(page);
  expect(
    calls.find((call) => call.command === "export_mailbox_mbox")?.args,
  ).toEqual({ accountId: expect.any(String), mailboxId: 1 });
  await attachIpcLog(page, testInfo);
});

test("FM2 cancel sends the operationId seen in progress", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?folderTotal=400");
  await exportFromInboxMenu(page);
  await expect(progressBar(page)).toHaveAttribute("aria-valuenow", /[1-9]/);
  await notices(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(notices(page).getByText("Cancelled.")).toBeVisible();
  const cancel = (await mboxCalls(page)).find(
    (call) => call.command === "cancel_mbox_operation",
  );
  expect(cancel?.args).toEqual({ operationId: "mbox-export-1" });
  await attachIpcLog(page, testInfo);
});

test("FM3 a dismissed save dialog shows nothing", async ({ page }) => {
  await page.goto("/?mboxDismissed=1");
  await exportFromInboxMenu(page);
  await expect
    .poll(async () =>
      (await mboxCalls(page)).some(
        (call) => call.command === "export_mailbox_mbox",
      ),
    )
    .toBe(true);
  await expect(progressBar(page)).toHaveCount(0);
  await expect(notices(page).locator(".notice")).toHaveCount(0);
});

test("FM4 a limit error shows its text", async ({ page }) => {
  await page.goto("/?mboxLimit=1");
  await exportFromInboxMenu(page);
  await expect(
    page.getByRole("alert").getByText("Too many messages to export at once."),
  ).toBeVisible();
  await expect(progressBar(page)).toHaveCount(0);
});

test("FM5 import refreshes the mailbox list", async ({ page }, testInfo) => {
  await page.goto("/");
  await inboxRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Import messages/ }).click();
  await expect(
    notices(page).getByText("Imported 2 messages. 1 message was skipped."),
  ).toBeVisible();
  const commands = (await ipcCalls(page)).map((call) => call.command);
  const after = commands.slice(commands.indexOf("import_mbox") + 1);
  expect(after).toContain("list_messages");
  await attachIpcLog(page, testInfo);
});

test("FM6 notices and mbox arguments never show a path", async ({
  page,
}, testInfo) => {
  await page.goto("/?folderTotal=40&mboxSkipped=1");
  await exportFromInboxMenu(page);
  await expect(notices(page).getByText(/Exported 38 messages/)).toBeVisible();
  await inboxRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Import messages/ }).click();
  await expect(notices(page).getByText(/Imported 2 messages/)).toBeVisible();
  const text = await notices(page).innerText();
  expect(text).not.toMatch(/[/\\]/);
  expect(JSON.stringify(await mboxCalls(page))).not.toMatch(/[/\\]/);
  await attachIpcLog(page, testInfo);
});

test("FM7 Export is reachable from the folder menu by keyboard", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const archive = page.getByRole("button", { name: /^Archive/ });
  await archive.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("e");
  await expect(
    menu.getByRole("menuitem", { name: /Export mailbox/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await mboxCalls(page)).find(
          (call) => call.command === "export_mailbox_mbox",
        )?.args,
    )
    .toEqual({ accountId: expect.any(String), mailboxId: 2 });
  await attachIpcLog(page, testInfo);
});

test("FM8 the command palette exports the current folder", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Archive/ }).click();
  await page.keyboard.press("ControlOrMeta+K");
  await page
    .getByRole("combobox", { name: /Search commands/ })
    .fill("export mailbox");
  await page.getByRole("option", { name: /Export mailbox/ }).click();
  await expect
    .poll(
      async () =>
        (await mboxCalls(page)).find(
          (call) => call.command === "export_mailbox_mbox",
        )?.args,
    )
    .toEqual({ accountId: expect.any(String), mailboxId: 2 });
  await attachIpcLog(page, testInfo);
});
