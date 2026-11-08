import { readFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, emitTauriEvent } from "./ipc";

// Failure modes covered here (WP5.13):
// 1. PDF pages do not render as images, or their alt text lacks "Page n of m".
// 2. A truncated document shows no notice that later pages are missing.
// 3. The app CSP in tauri.conf.json changes while the preview ships.
// 4. A page that is not a data:image URL is rendered anyway.
// 5. The reader Preview button does not reach the PDF pages.

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'none'; font-src 'self' data:; frame-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'";

async function openPreview(page: Page, query = "") {
  await page.goto(`/?emlSeeded=1${query ? `&${query}` : ""}`);
  await expect(page.locator(".app-viewport")).toBeVisible();
  await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
  const viewer = page.getByRole("dialog", { name: "Lease renewal" });
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "Preview: Lease.pdf" }).click();
  return page.getByRole("dialog", { name: "Preview of Lease.pdf" });
}

test.describe("pdf preview", () => {
  test.beforeEach(async ({ page }) => installMockIpc(page));

  test("three pages render as images with page alt text", async ({
    page,
  }, testInfo: TestInfo) => {
    const preview = await openPreview(page);
    const pages = preview.getByRole("img", { name: /^Page \d of 3$/ });
    await expect(pages).toHaveCount(3);
    for (const name of ["Page 1 of 3", "Page 2 of 3", "Page 3 of 3"]) {
      await expect(
        preview.getByRole("img", { name, exact: true }),
      ).toHaveAttribute("src", /^data:image\/png;base64,/);
    }
    await expect(
      preview.getByText(/Only the first pages are shown/),
    ).toHaveCount(0);
    await attachArtifacts(page, testInfo, "pdf-preview-pages");
  });

  test("a truncated document shows the notice", async ({
    page,
  }, testInfo: TestInfo) => {
    const preview = await openPreview(page, "pdfTruncated=1");
    await expect(
      preview.getByText(
        "Only the first pages are shown. Save the file to see the rest.",
      ),
    ).toBeVisible();
    await expect(
      preview.getByRole("img", { name: "Page 8 of 12", exact: true }),
    ).toBeVisible();
    await attachArtifacts(page, testInfo, "pdf-preview-truncated");
  });

  test("the app CSP in tauri.conf.json is unchanged", async ({
    page,
  }, testInfo: TestInfo) => {
    const config = JSON.parse(
      readFileSync("src-tauri/tauri.conf.json", "utf8"),
    ) as {
      app: { security: { csp: string } };
    };
    expect(config.app.security.csp).toBe(CSP);
    await attachArtifacts(page, testInfo, "pdf-preview-csp");
  });

  test("a page that is not a data:image URL is not rendered", async ({
    page,
  }, testInfo: TestInfo) => {
    const preview = await openPreview(page, "pdfBadPage=1");
    await expect(
      preview.getByRole("img", { name: "Page 2 of 3", exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByRole("img", { name: "Page 3 of 3", exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByRole("img", { name: "Page 1 of 3", exact: true }),
    ).toHaveCount(0);
    await expect(preview.locator('img[src^="https:"]')).toHaveCount(0);
    await attachArtifacts(page, testInfo, "pdf-preview-bad-page");
  });

  test("the reader Preview button reaches the PDF pages", async ({
    page,
  }, testInfo: TestInfo) => {
    await page.goto("/?rfcMessage=1");
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    await page.getByRole("button", { name: "Preview: Lease.pdf" }).click();
    const preview = page.getByRole("dialog", { name: "Preview of Lease.pdf" });
    await expect(
      preview.getByRole("img", { name: /^Page \d of 3$/ }),
    ).toHaveCount(3);
    await attachArtifacts(page, testInfo, "pdf-preview-reader");
  });
});
