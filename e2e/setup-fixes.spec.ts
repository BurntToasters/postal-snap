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
  await page.screenshot({ path: "test-results/setup-fixes-settings.png" });
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
  await page.screenshot({ path: "test-results/setup-fixes-quiet-step.png" });
});

// Failure modes around the first-sync screen:
// - an offline event refreshes accounts before add_account resolves and drops
//   the user into the mailbox before first-sync progress appears;
// - a later offline event must keep the first-sync screen mounted;
// - "Open mailbox" marks setup done before accounts reload, flashing the
//   standalone add-account screen.
async function connectIcloud(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("app-password");
  await page.getByRole("button", { name: "Connect securely" }).click();
}

async function emitOfflineAndWaitForRefresh(
  page: import("@playwright/test").Page,
) {
  const before = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.accountLoads ?? 0,
  );
  await page.evaluate(async () => {
    const internals = (
      window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    await internals.invoke("plugin:event|emit", {
      event: "sync-state",
      payload: { accountId: "account-1", phase: "offline" },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.accountLoads ?? 0),
    )
    .toBeGreaterThan(before);
}

for (const [label, url, prepare] of [
  ["first-run", "/?firstRun=1", reachAccountStep],
  ["standalone", "/?noAccounts=1", async () => undefined],
] as const) {
  test(`stays on the ${label} first-sync screen when sync goes offline`, async ({
    page,
  }) => {
    await page.goto(url);
    await prepare(page);
    await connectIcloud(page);
    const heading = page.getByRole("heading", { name: "Getting your mail…" });
    await expect(heading).toBeVisible();

    await emitOfflineAndWaitForRefresh(page);
    await expect(heading).toBeVisible();
    await page.screenshot({
      path: `test-results/setup-fixes-offline-${label}.png`,
    });

    await page.getByRole("button", { name: "Open mailbox" }).click();
    await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  });
}

test("open mailbox goes straight to the mailbox and marks setup done", async ({
  page,
}) => {
  await page.goto("/?firstRun=1");
  await reachAccountStep(page);
  await connectIcloud(page);
  await expect(
    page.getByRole("heading", { name: "Getting your mail…" }),
  ).toBeVisible();

  // Record any frame where the standalone add-account screen appears.
  await page.evaluate(() => {
    const flags = window as typeof window & { standaloneFlash?: boolean };
    new MutationObserver(() => {
      if (
        document.querySelector(
          ".provider-picker:not(.provider-picker-embedded)",
        )
      )
        flags.standaloneFlash = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "Open mailbox" }).click();
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { standaloneFlash?: boolean })
          .standaloneFlash ?? false,
    ),
  ).toBe(false);
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
  await page.screenshot({ path: "test-results/setup-fixes-open-mailbox.png" });
});

for (const [label, url, prepare] of [
  ["first-run", "/?firstRun=1&delayAddAccount=1", reachAccountStep],
  ["standalone", "/?noAccounts=1&delayAddAccount=1", async () => undefined],
] as const) {
  test(`keeps ${label} setup mounted when sync refreshes accounts before add returns`, async ({
    page,
  }) => {
    await page.goto(url);
    await prepare(page);
    await connectIcloud(page);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(window.__POSTAL_SNAP_TEST__?.releaseAddAccount),
        ),
      )
      .toBe(true);

    await emitOfflineAndWaitForRefresh(page);
    await page.screenshot({
      path: `test-results/setup-fixes-offline-before-add-returns-${label}.png`,
    });
    try {
      await expect(
        page.getByText("Testing secure incoming and outgoing connections…"),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Compose", exact: true }),
      ).toHaveCount(0);
    } finally {
      await page.evaluate(() =>
        window.__POSTAL_SNAP_TEST__?.releaseAddAccount?.(),
      );
    }
    await expect(
      page.getByRole("heading", { name: "Getting your mail…" }),
    ).toBeVisible();
  });
}

test("claims setup after removing last account before a new connect", async ({
  page,
}) => {
  await page.goto("/?delayAddAccount=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  page.once("dialog", async (dialog) => dialog.accept());
  await page
    .locator(".account-settings-card")
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(
    page.locator(".provider-picker:not(.provider-picker-embedded)"),
  ).toBeVisible();

  await connectIcloud(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(window.__POSTAL_SNAP_TEST__?.releaseAddAccount),
      ),
    )
    .toBe(true);
  await emitOfflineAndWaitForRefresh(page);
  await page.screenshot({
    path: "test-results/setup-fixes-offline-after-last-account-removal.png",
  });
  try {
    await expect(
      page.getByText("Testing secure incoming and outgoing connections…"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Compose", exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__?.releaseAddAccount?.(),
    );
  }
  await expect(
    page.getByRole("heading", { name: "Getting your mail…" }),
  ).toBeVisible();
});
