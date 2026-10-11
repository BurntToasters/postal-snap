import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A printed message names each regular file and its size.
// 2. A picture placed in the letter is left off that line.
// 3. A message with no files leaves the line off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/print-files-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test.describe("macOS print", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  });

  test("a printed message names its files", async ({ page }) => {
    await page.goto("/?previewable=1&filePair=1");
    await page
      .getByRole("option", { name: /Weekend plans/i })
      .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
      .click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menuitem", { name: "Print message", exact: true })
      .click();
    const frame = page.locator("body > .print-host iframe");
    await expect(frame).toHaveCount(1);
    const srcdoc = await frame.getAttribute("srcdoc");
    expect(srcdoc).toContain("Attachments");
    expect(srcdoc).toContain("family.png (128 B)");
    expect(srcdoc).toContain("notes.txt (64 B)");
    expect(srcdoc).not.toContain("<script");
    await expect(
      page.getByRole("heading", { name: "Weekend plans" }),
    ).toBeVisible();
  });

  test("a picture in the letter stays off the file line", async ({ page }) => {
    await page.goto("/?inline=1");
    await page
      .getByRole("option", { name: /Weekend plans/i })
      .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
      .click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menuitem", { name: "Print message", exact: true })
      .click();
    const srcdoc = await page
      .locator("body > .print-host iframe")
      .getAttribute("srcdoc");
    expect(srcdoc).not.toContain(">Attachments<");
    expect(srcdoc).not.toContain("family.png");
  });

  test("a message with no files leaves that line off", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("option", { name: /Weekend plans/i })
      .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
      .click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menuitem", { name: "Print message", exact: true })
      .click();
    const srcdoc = await page
      .locator("body > .print-host iframe")
      .getAttribute("srcdoc");
    expect(srcdoc).toContain("Weekend plans");
    expect(srcdoc).not.toContain(">Attachments<");
  });
});
