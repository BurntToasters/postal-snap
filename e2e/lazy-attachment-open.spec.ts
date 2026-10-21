import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts, ipcCommands } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section E):
// 1. A partial message hides its known attachments or never says why they are missing.
// 2. Download full message does nothing, or the notice stays after it succeeds.
// 3. The refreshed attachment IDs are ignored, so Save uses a stale ID.
// 4. Saving an attachment of a partial message never reaches the backend.
// 5. The offline setting does not save, does not survive reopening, or is not searchable.
// 6. The notice or its button is unnamed, under 44px, or clipped at 200% text.
// Inline cid images (E10) and source export (E6) are not covered here.

const NOTICE = "Attachments are not downloaded yet (12.4 MB message).";

const configs = [
  { name: "comfortable", query: "density=comfortable&scale=1" },
  { name: "compact", query: "density=compact&scale=1" },
  { name: "text-200", query: "density=comfortable&scale=2" },
  { name: "compact-200", query: "density=compact&scale=2" },
] as const;

async function openPartialMessage(page: Page, query: string) {
  await page.goto(`/?partialMessage=1&${query}`);
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

async function recordedArgs(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [])
        .filter((call) => call.command === name)
        .map((call) => call.args),
    command,
  );
}

for (const { name, query } of configs) {
  test.describe(`lazy attachments (${name})`, () => {
    test.beforeEach(async ({ page }) => installMockIpc(page));

    test("explains a partial message and lists its known attachments", async ({
      page,
    }, testInfo) => {
      await openPartialMessage(page, query);
      await expect(page.getByText(NOTICE, { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Quarterly report\.pdf/ }),
      ).toBeVisible();
      const download = page.getByRole("button", {
        name: "Download full message",
        exact: true,
      });
      await expect(download).toBeEnabled();
      if (name === "comfortable") {
        const box = await download.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      await expectAxeClean(page);
      await attachArtifacts(page, testInfo, `lazy-attachment-list-${name}`);
    });

    test("downloads the full message and refreshes attachment IDs", async ({
      page,
    }, testInfo) => {
      await openPartialMessage(page, query);
      await page
        .getByRole("button", { name: "Download full message", exact: true })
        .click();
      await expect
        .poll(() => ipcCommands(page))
        .toContain("download_full_message");
      await expect(page.getByText(NOTICE, { exact: true })).toHaveCount(0);
      await expect(
        page.locator('[data-attachment-id="full-report"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-attachment-id="partial-report"]'),
      ).toHaveCount(0);
      await attachArtifacts(page, testInfo, `lazy-attachment-full-${name}`);
    });

    test("saves a partial attachment through the backend command", async ({
      page,
    }, testInfo) => {
      await openPartialMessage(page, query);
      await page
        .getByRole("button", { name: /Download file: Quarterly report\.pdf/ })
        .click();
      await expect.poll(() => ipcCommands(page)).toContain("save_attachment");
      const [args] = await recordedArgs(page, "save_attachment");
      expect(args).toMatchObject({
        accountId: "account-1",
        attachmentId: "partial-report",
        suggestedFilename: "Quarterly report.pdf",
      });
      await attachArtifacts(page, testInfo, `lazy-attachment-save-${name}`);
    });
  });
}

test.describe("keep attachments offline setting", () => {
  test.beforeEach(async ({ page }) => installMockIpc(page));

  test("saves the setting and keeps it after reopening Settings", async ({
    page,
  }, testInfo) => {
    await page.goto("/?density=comfortable&scale=1");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Storage", exact: true }).click();
    const toggle = page.getByRole("checkbox", {
      name: "Keep attachments for offline use",
    });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect
      .poll(async () =>
        (await recordedArgs(page, "save_settings")).some(
          (args) =>
            (args as { settings?: { keepAttachmentsOffline?: boolean } })
              .settings?.keepAttachmentsOffline === true,
        ),
      )
      .toBe(true);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Storage", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Keep attachments for offline use" }),
    ).toBeChecked();
    await attachArtifacts(page, testInfo, "keep-attachments-setting");
  });

  test("finds the setting from Settings search", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("searchbox", { name: "Search settings" })
      .fill("offline attachments");
    await page
      .getByRole("button", { name: /Keep attachments for offline use/ })
      .click();
    await expect(
      page.getByRole("checkbox", { name: "Keep attachments for offline use" }),
    ).toBeVisible();
    await attachArtifacts(page, testInfo, "keep-attachments-setting-search");
  });
});
