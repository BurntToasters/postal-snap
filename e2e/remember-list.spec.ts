import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A saved oldest-first unread mailbox opens that way.
// 2. Choosing All and Date writes those choices into settings.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/remember-list-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a saved mailbox order and filter open again and a change is stored", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&mailboxSort=dateOldest&mailboxFilter=unread");
  const options = page.getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAccessibleName(/Older family note/i);
  await expect(page.getByRole("radio", { name: "Unread" })).toBeChecked();

  const opened = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  expect(
    opened.some(
      (call) =>
        call.command === "list_messages" &&
        call.args.filter === "unread" &&
        call.args.sort === "dateOldest",
    ),
  ).toBe(true);

  await page.getByRole("radio", { name: "All", exact: true }).click();
  await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
      );
      return calls.some((call) => {
        if (call.command !== "save_settings") return false;
        const views = (
          call.args.settings as
            | { mailboxViews?: { mailboxId?: number; filter?: string }[] }
            | undefined
        )?.mailboxViews;
        return views?.some(
          (view) => view.mailboxId === 1 && view.filter === "all",
        );
      });
    })
    .toBe(true);

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitemradio", { name: "Date", exact: true }).click();
  await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
      );
      return calls.some((call) => {
        if (call.command !== "save_settings") return false;
        const views = (
          call.args.settings as
            | {
                mailboxViews?: {
                  mailboxId?: number;
                  sort?: string;
                  filter?: string;
                }[];
              }
            | undefined
        )?.mailboxViews;
        return views?.some(
          (view) =>
            view.mailboxId === 1 &&
            view.sort === "date" &&
            view.filter === "all",
        );
      });
    })
    .toBe(true);
});
