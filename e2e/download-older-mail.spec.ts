import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Once the downloaded mail runs out, older mail on the server is
//    unreachable from the list.
// 2. The request names a different mailbox than the one shown.
// 3. The button stays after the server reports no older mail.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

test("downloads older mail from the server after the cache runs out", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const button = page.getByRole("button", { name: "Download older mail" });
  await expect(button).toBeVisible();
  await button.click();
  await expect
    .poll(async () =>
      (await recordedCalls(page)).filter(
        (call) => call.command === "load_older_messages",
      ),
    )
    .toHaveLength(1);
  const calls = await recordedCalls(page);
  const request = calls.find((call) => call.command === "load_older_messages")
    ?.args as { accountId: string; mailboxId: number };
  const listed = calls.find((call) => call.command === "list_messages")
    ?.args as { accountId: string; mailboxId: number };
  expect(request).toMatchObject({
    accountId: listed.accountId,
    mailboxId: listed.mailboxId,
  });
  await expect(button).toHaveCount(0);
  await attachIpcLog(page, testInfo);
});

test("keeps offering older mail while the server has more", async ({
  page,
}) => {
  await page.goto("/?olderOnServer=1");
  const button = page.getByRole("button", { name: "Download older mail" });
  await button.click();
  await expect(button).toBeVisible();
});
