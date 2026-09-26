import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Reply to a message the user sent addresses the user instead of the
//    original recipients.
// 2. Reply all to a sent message puts the user in To or Cc.
// 3. Reply all to received mail drops Cc recipients or repeats the sender.
// 4. Reply to a note sent to yourself leaves To empty.
// Recipient fields are written to test-results/reply-recipients.json.

test.beforeEach(async ({ page }) => installMockIpc(page));

const results: Record<string, { to: string; cc: string }> = {};

test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/reply-recipients.json",
    JSON.stringify(results, null, 2),
  );
});

async function openAndReply(page: Page, query: string, action: string) {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`/${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: action, exact: true }).click();
  const to = page.getByRole("combobox", { name: "To", exact: true });
  await expect(to).toBeVisible();
  const cc = page.getByRole("combobox", { name: "Cc", exact: true });
  const fields = {
    to: await to.inputValue(),
    cc: (await cc.count()) ? await cc.inputValue() : "",
  };
  results[`${action} ${query}`] = fields;
  return fields;
}

test("reply to own sent message goes to its recipients", async ({ page }) => {
  const fields = await openAndReply(page, "?fromSelf=1", "Reply");
  expect(fields.to).toBe("jane@example.com");
});

test("reply all to own sent message keeps others only", async ({ page }) => {
  const fields = await openAndReply(page, "?fromSelf=1", "Reply all");
  expect(fields.to).toBe("jane@example.com");
  expect(fields.cc).toBe("lee@example.com");
});

test("reply to received mail goes to the sender", async ({ page }) => {
  const fields = await openAndReply(page, "", "Reply");
  expect(fields.to).toBe("jane@example.com");
  expect(fields.cc).toBe("");
});

test("reply to a note to yourself keeps your address", async ({ page }) => {
  const fields = await openAndReply(page, "?noteToSelf=1", "Reply");
  expect(fields.to).toBe("sam@icloud.com");
});
