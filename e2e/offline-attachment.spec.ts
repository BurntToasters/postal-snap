import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts, ipcCommands } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, E9):
// 1. Offline, a partial message offers Download full message and fails with a raw error.
// 2. Offline, the attachment open or save buttons call the backend and show a connection error.
// 3. The offline notice does not say attachments come back when online.
// 4. Offline disables attachments that are already stored locally (over-blocking).
// 5. The offline button is unnamed or loses its disabled state at 200% text.

const OFFLINE_LINE = "Attachments are available when you are online.";
const RAW_CONNECTION_ERROR = "Could not reach the mail server";

const configs = [
  { name: "comfortable", query: "density=comfortable&scale=1" },
  { name: "compact", query: "density=compact&scale=1" },
  { name: "text-200", query: "density=comfortable&scale=2" },
  { name: "compact-200", query: "density=compact&scale=2" },
] as const;

async function openMessage(page: Page, query: string) {
  await page.goto(query);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
}

async function expectAxeClean(page: Page) {
  const scan = await new AxeBuilder({ page })
    .include("#message-attachments")
    .analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

for (const { name, query } of configs) {
  test.describe(`offline attachments (${name})`, () => {
    test.beforeEach(async ({ page }) => installMockIpc(page));

    test("disables partial attachment actions with a plain online notice", async ({
      page,
    }, testInfo) => {
      await openMessage(page, `/?partialMessage=1&offline=1&${query}`);
      await expect(
        page.getByRole("button", {
          name: "Download full message",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(page.getByText(OFFLINE_LINE, { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Download file: Quarterly report/ }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: /Preview: family\.png/ }),
      ).toBeDisabled();
      await expect(page.getByText(RAW_CONNECTION_ERROR)).toHaveCount(0);
      await expectAxeClean(page);
      await attachArtifacts(page, testInfo, `offline-attachment-${name}`);
    });

    test("sends no attachment command while offline", async ({
      page,
    }, testInfo) => {
      await openMessage(page, `/?partialMessage=1&offline=1&${query}`);
      await page
        .getByRole("button", { name: /Download file: Quarterly report/ })
        .click({ force: true });
      await expect(page.getByText(RAW_CONNECTION_ERROR)).toHaveCount(0);
      const commands = await ipcCommands(page);
      expect(commands).not.toContain("save_attachment");
      expect(commands).not.toContain("download_full_message");
      await attachArtifacts(page, testInfo, `offline-no-command-${name}`);
    });
  });
}

test("keeps locally stored attachments usable while offline", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await openMessage(page, "/?previewable=1&offline=1");
  await expect(
    page.getByRole("button", { name: /Download file: family\.png/ }),
  ).toBeEnabled();
  await expect(page.getByText(OFFLINE_LINE, { exact: true })).toHaveCount(0);
  await attachArtifacts(page, testInfo, "offline-local-attachment");
});
