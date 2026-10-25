import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure hypotheses: the scrolling footer clips Send options; image preview
// leaves keyboard focus behind its modal or Escape closes the composer.
test.beforeEach(async ({ page }) => installMockIpc(page));
test.afterEach(async ({ page }, info) => {
  await info.attach("audit-screen", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

for (const density of ["comfortable", "compact"]) {
  test(`Send options receive pointer hits at 200% ${density}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await page.goto(`/?density=${density}&scale=2`);
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    await page.locator("#composer-to").fill("pat@example.com");
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .fill("Audit");
    await page
      .getByRole("textbox", { name: "Message body" })
      .fill("Audit body");
    await page.getByRole("button", { name: "Send options" }).click();
    const item = page.getByRole("menuitem", { name: "Send now", exact: true });
    await expect(item).toBeVisible();
    const hit = await item.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return node.contains(
        document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      );
    });
    expect(hit, "Send now must receive pointer clicks").toBe(true);
  });

  test(`Image preview owns keyboard focus ${density}`, async ({ page }) => {
    await page.goto(`/?pickImage=1&density=${density}&scale=2`);
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await page
      .getByRole("button", { name: "Preview family-photo.jpg" })
      .click();
    const preview = page.getByRole("dialog", { name: "family-photo.jpg" });
    await expect(preview).toBeVisible();
    await page.keyboard.press("Tab");
    expect
      .soft(
        await preview.evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect.soft(preview).toHaveCount(0);
    await expect.soft(page.locator(".composer-window")).toBeVisible();
  });
}
