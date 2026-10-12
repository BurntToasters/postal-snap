import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A search is forgotten as soon as the box is cleared.
// 2. Choosing a recent search does not run that search.
// 3. Clear recent searches leaves the old query in the menu.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/recent-search-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a recent search can be chosen again and then cleared", async ({
  page,
}) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("Picnic");
  await search.press("Enter");
  await expect
    .poll(async () =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "remember_search",
          args: expect.objectContaining({ query: "Picnic" }),
        }),
      ]),
    );

  await search.fill("");
  await search.blur();
  await search.focus();
  await page.getByRole("menuitem", { name: "Picnic", exact: true }).click();
  await expect(search).toHaveValue("Picnic");

  await search.fill("");
  await search.blur();
  await search.focus();
  await page
    .getByRole("menuitem", { name: "Clear recent searches", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Picnic", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "forget_recent_searches" }),
      ]),
    );
});
