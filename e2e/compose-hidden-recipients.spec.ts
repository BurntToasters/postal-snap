import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The Bcc or Cc toggle hides a field that still holds recipients.
// 2. The toggle gives no sign that the field holds recipients.
// 3. An empty field can no longer be hidden.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

for (const density of ["comfortable", "compact"] as const) {
  for (const scale of [1, 2]) {
    for (const field of ["Cc", "Bcc"] as const) {
      test(`${field} stays visible: ${density}, ${scale * 100}%`, async ({
        page,
      }, testInfo) => {
        await page.goto(`/?density=${density}&scale=${scale}`);
        await page
          .getByRole("button", { name: "Compose", exact: true })
          .click();
        const toggle = page
          .locator(".cc-toggle")
          .filter({ hasText: new RegExp(`^${field}`) });
        const input = page.locator(`#composer-${field.toLowerCase()}`);

        await toggle.click();
        await expect(input).toBeVisible();
        await input.fill("lee@example.com, kim@example.com");
        await expect(toggle).toHaveText(`${field} (2)`);

        await toggle.click();
        await expect(input).toBeVisible();
        await expect(input).toBeFocused();

        await input.fill("");
        await expect(toggle).toHaveText(field);
        await toggle.click();
        await expect(input).toHaveCount(0);
        await attachIpcLog(page, testInfo);
      });
    }
  }
}
