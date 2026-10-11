import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Duplicate saves a new draft and opens it.
// 2. The copy keeps the letter and files, and is not scheduled.
// The test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/duplicate-draft-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("duplicates a draft as a new message", async ({ page }) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page
    .getByRole("button", { name: /Family update/i })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.locator("#composer-subject")).toHaveValue("Family update");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.find((call) => {
            if (call.command !== "save_draft") return false;
            const draft = call.args.draft as { id?: string } | undefined;
            return !draft?.id;
          })?.args.draft,
      ),
    )
    .toMatchObject({
      subject: "Family update",
      sendAt: null,
      htmlBody: "<p>Draft message</p>",
    });
  await page
    .locator(".composer-window")
    .getByRole("button", { name: "Save draft and close" })
    .click();
  await expect(
    page.getByRole("button", { name: /Family update/i }),
  ).toHaveCount(2);
});
