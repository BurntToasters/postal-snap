import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message from the account's own address offers Block sender or Block domain,
//    so one confirm would send the user's own mail to Junk.
// 2. A sender at a shared provider (gmail.com) offers Block domain, which would
//    junk mail from everyone at that provider.
// 3. The guard hides the actions in one menu but not the other.
// 4. An ordinary sender loses Block sender or Block domain.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/block-own-and-shared-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function menuNames(page: Page): Promise<{
  more: string[];
  context: string[];
}> {
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.click();
  await page.getByRole("button", { name: "More actions" }).click();
  const more = await page
    .getByRole("menu", { name: "More actions" })
    .getByRole("menuitem")
    .allInnerTexts();
  await page.keyboard.press("Escape");
  await row.click({ button: "right" });
  const context = await page
    .getByRole("menu", { name: "Actions" })
    .getByRole("menuitem")
    .allInnerTexts();
  await page.keyboard.press("Escape");
  return {
    more: more.map((item) => item.trim()),
    context: context.map((item) => item.trim()),
  };
}

test("own mail offers no block actions", async ({ page }) => {
  await page.goto("/?fromSelf=1");
  const { more, context } = await menuNames(page);
  for (const names of [more, context]) {
    expect(names).not.toContain("Block sender");
    expect(names).not.toContain("Block domain");
  }
});

test("a shared provider offers Block sender but not Block domain", async ({
  page,
}) => {
  await page.goto("/?sender=jane@gmail.com");
  const { more, context } = await menuNames(page);
  for (const names of [more, context]) {
    expect(names).toContain("Block sender");
    expect(names).not.toContain("Block domain");
  }
});

test("an ordinary sender keeps both block actions", async ({ page }) => {
  await page.goto("/");
  const { more, context } = await menuNames(page);
  for (const names of [more, context]) {
    expect(names).toContain("Block sender");
    expect(names).toContain("Block domain");
  }
});
