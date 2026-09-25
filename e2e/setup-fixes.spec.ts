import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Accounts exist but setupCompleted is false: user is sent back into setup.
// 2. A failed settings save in setup shows "Saving…" as the error.
// 3. After an account is saved, Back/Skip stay visible and invite a duplicate.
// 4. The account step offers no way to reach Settings.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function reachAccountStep(page: import("@playwright/test").Page) {
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
}

test("opens the mailbox when accounts exist but setup was never marked done", async ({
  page,
}) => {
  await page.goto("/?setupIncomplete=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await expect(page.locator(".setup-flow")).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window.__POSTAL_SNAP_TEST__?.savedSettings as Array<{
            setupCompleted?: boolean;
          }>
        ).some((saved) => saved.setupCompleted === true),
      ),
    )
    .toBe(true);

  await page.screenshot({ path: "test-results/setup-fixes-repaired.png" });
});

test("shows a plain error when a setup choice cannot be saved", async ({
  page,
}) => {
  await page.goto("/?firstRun=1&failDarkSave=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Could not save that change");
  await expect(alert).not.toContainText("Saving…");
  // The failed choice is rolled back instead of looking saved.
  await expect(page.getByRole("combobox", { name: "Appearance" })).toHaveValue(
    "system",
  );

  await page.screenshot({ path: "test-results/setup-fixes-save-error.png" });
});

test("hides back and skip once the account is saved", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await reachAccountStep(page);
  await expect(
    page.getByRole("button", { name: "Back to setup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Skip for now|Set up later/ }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("app-password");
  await page.getByRole("button", { name: "Connect securely" }).click();

  await expect(
    page.getByRole("heading", { name: "Getting your mail…" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to setup" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Open Settings" })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "test-results/setup-fixes-account-saved.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Open mailbox" }).click();
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
});

test("reaches Settings from the account step", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await reachAccountStep(page);
  await page.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

// Failure mode: a background save of the current step fails and setup blames
// the user for a change they never made.
test("keeps quiet when only the saved setup step fails", async ({ page }) => {
  await page.goto("/?firstRun=1&failStepSave=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose how mail looks" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make it comfortable" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // A real choice still reports its own failure.
  await page.goto("/?firstRun=1&failDarkSave=1&failStepSave=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
  await expect(page.getByRole("alert")).toContainText(
    "Could not save that change",
  );
});
