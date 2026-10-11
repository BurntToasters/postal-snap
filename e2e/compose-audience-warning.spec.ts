import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Ten or more recipients send with no warning.
// 2. The safe choice is not focused, or Escape sends the message.
// 3. "Send anyway" drops recipients or never calls send.
// The run ends with a screenshot and the recorded IPC calls.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

const people = Array.from(
  { length: 10 },
  (_, index) => `person${index}@example.test`,
).join(", ");

test("warns before sending to 10 or more people", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill(people);
  await page.getByRole("textbox", { name: "Subject" }).fill("Group note");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const dialog = page.getByRole("alertdialog", {
    name: "Send to this many people?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This message has 10 recipients.");
  await expect(
    dialog.getByRole("button", { name: "Review recipients" }),
  ).toBeFocused();
  expect(
    (await recordedCalls(page)).filter(
      (call) => call.command === "send_message",
    ),
  ).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".composer-window")).toBeVisible();

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.getByRole("button", { name: "Send anyway" }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const calls = (await recordedCalls(page)).filter(
    (call) => call.command === "send_message",
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toMatchObject({
    draft: { to: people.split(", "), subject: "Group note" },
  });

  await page.screenshot({
    path: "test-results/compose-audience-warning.png",
  });
  await testInfo.attach("final.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await attachIpcLog(page, testInfo);
});
