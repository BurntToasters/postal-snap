import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

test("switches isolated accounts from the account popover and clears stale mail state", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("searchbox", { name: "Search mail" }).fill("weekend");

  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  const switcher = page.getByRole("menu", { name: "Email accounts" });
  await expect(switcher.getByRole("menuitem", { name: /Sam/ })).toContainText(
    "1",
  );
  await expect(switcher.getByRole("menuitem", { name: /Work/ })).toContainText(
    "3",
  );
  await switcher.getByRole("menuitem", { name: /Work/ }).click();

  await expect(
    page.getByRole("option", { name: /Team launch/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search mail" }),
  ).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);

  await page.keyboard.press("Control+1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
});

test("shows per-account status and switcher actions", async ({ page }) => {
  await page.goto("/?multiAccount=1&secondOffline=1");
  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  const switcher = page.getByRole("menu", { name: "Email accounts" });
  await expect(switcher.getByRole("menuitem", { name: /Work/ })).toContainText(
    "Offline",
  );
  await expect(
    switcher.getByRole("menuitem", { name: "Get mail for all accounts" }),
  ).toBeVisible();
  await expect(
    switcher.getByRole("menuitem", { name: "Account settings" }),
  ).toBeVisible();
  await expect(
    switcher.getByRole("menuitem", { name: "Add account" }),
  ).toBeVisible();
});

test("offers account actions from the product context menu", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  await page
    .getByRole("button", { name: /Sam.*sam@icloud\.com/i })
    .click({ button: "right" });

  const menu = page.locator(".context-menu");
  await expect(menu.getByRole("menuitem", { name: "Get Mail" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Account settings" }).click();
  await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("remembers the open folder separately for each account", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  await page.getByRole("button", { name: /^Archive/ }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();

  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitem", { name: /Work/ })
    .click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  await page.getByRole("button", { name: /^Archive/ }).click();
  await page
    .getByRole("button", { name: /Work.*reader@fastmail\.com/i })
    .click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitem", { name: /Sam/ })
    .click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
});

test("opens a sent notice in the account that owns its outbox", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&localMail=1");
  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitem", { name: /Work/ })
    .click();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Work note");
  await page.getByLabel("Message body").fill("From the work account.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await page
    .getByRole("button", { name: /Work.*reader@fastmail\.com/i })
    .click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitem", { name: /Sam/ })
    .click();
  await page
    .locator(".sent-toast")
    .getByRole("button", { name: "View Outbox" })
    .click();

  await expect(
    page.getByRole("button", { name: /Work.*reader@fastmail\.com/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outbox" })).toBeVisible();
});

test("matches reply aliases as complete addresses", async ({ page }) => {
  await page.goto("/?aliasCollision=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByLabel("From address")).toHaveValue("sam@icloud.com");
});

test("reloads persisted account errors after a terminal sync state", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  await page.evaluate(async () => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock state is missing.");
    mock.account.syncState = "authFailed";
    mock.account.error = "Sign-in failed. Update the account password.";
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
      payload: { accountId: mock.account.id, phase: "authFailed" },
    });
  });

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await expect(page.getByRole("alert")).toContainText("Sign-in failed");
});

test("warns about local work before removing an account", async ({ page }) => {
  await page.goto("/?multiAccount=1&removalImpact=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();

  const dialogMessage = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  await page
    .locator(".account-settings-card")
    .first()
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(dialogMessage).resolves.toContain("2 unsent messages");
  await expect(dialogMessage).resolves.toContain("1 unsynced draft");
  await expect(dialogMessage).resolves.toContain("3 queued changes");
});
