import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. New mail plays a sound until the preference is turned off.
// 2. Turning the preference off does not get stored.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/new-mail-sound-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new-mail alert plays a sound until that preference is off", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Notifications" }).click();
  const sound = page.getByRole("checkbox", {
    name: /Play a sound for new mail/,
  });
  await expect(sound).toBeChecked();
  await sound.click();
  await expect(sound).not.toBeChecked();
  await page.keyboard.press("Escape");

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __POSTAL_SNAP_TEST__?: {
                savedSettings?: Array<{ newMailSound?: boolean }>;
              };
            }
          ).__POSTAL_SNAP_TEST__?.savedSettings?.at(-1)?.newMailSound,
      ),
    )
    .toBe(false);
});
