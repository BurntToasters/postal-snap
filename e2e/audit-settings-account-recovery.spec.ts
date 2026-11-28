import { expect, test } from "./coverage-fixture";
import { attachArtifactsAfterEach } from "./ipc";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));
test.afterEach(attachArtifactsAfterEach);

async function createLocalBridgeAccount(page: import("@playwright/test").Page) {
  await page.goto("/?noAccounts=1&multiAccount=1&pendingConnectionWork=1");
  await page.evaluate(() => {
    const account = window.__POSTAL_SNAP_MOCK__!.account;
    Object.assign(account, {
      provider: "protonBridge",
      displayName: "Local Bridge",
      email: "bridge@local.test",
    });
  });
  await page.getByRole("button", { name: /Proton Bridge/ }).click();
  await page.getByLabel("Your name").fill("Local Bridge");
  const acceptSetupDialog = (dialog: import("@playwright/test").Dialog) =>
    void dialog.accept();
  page.on("dialog", acceptSetupDialog);
  await page
    .getByLabel("Email address", { exact: true })
    .fill("bridge@local.test");
  await page
    .getByLabel("Bridge password", { exact: true })
    .fill("test-only-bridge-password");
  await page
    .getByRole("group", { name: "Incoming IMAP" })
    .getByLabel("Username")
    .fill("bridge@local.test");
  await page
    .getByRole("group", { name: "Outgoing SMTP" })
    .getByLabel("Username")
    .fill("bridge@local.test");
  await page.getByRole("button", { name: "Connect securely" }).click();
  page.off("dialog", acceptSetupDialog);
  await page.getByRole("button", { name: "Open mailbox", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: /^Manage Local Bridge\b/ }).click();
}

test("account downloads keep pending Outbox mail through cancel and failures", async ({
  page,
}) => {
  await createLocalBridgeAccount(page);
  const clear = page.getByRole("button", {
    name: "Clear this account's downloaded mail",
    exact: true,
  });

  page.once("dialog", (dialog) => void dialog.dismiss());
  await clear.click();
  expect(
    await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__!.ipcCalls.some(
        (call) => call.command === "clear_account_downloads",
      ),
    ),
  ).toBe(false);

  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    mock.handlers.clear_account_downloads = () => {
      throw mock.mockError(
        "localStorageFailed",
        "PRIVATE_DOWNLOAD_PATH /tmp/private-cache",
      );
    };
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await clear.click();
  const error = page.getByRole("alert");
  await expect(error).toContainText(
    "The download setting could not be saved. Try again.",
  );
  await expect(error).not.toContainText("PRIVATE_DOWNLOAD_PATH");

  await page.evaluate(() => {
    window.__POSTAL_SNAP_MOCK__!.handlers.clear_account_downloads = () =>
      undefined;
    window.__POSTAL_SNAP_MOCK__!.handlers.set_account_cache_policy = () => {
      throw window.__POSTAL_SNAP_MOCK__!.mockError(
        "localStorageFailed",
        "PRIVATE_POLICY_PATH /tmp/private-cache-policy",
      );
    };
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await clear.click();
  await expect(
    page.getByText("Download setting saved.", { exact: true }),
  ).toBeVisible();

  const keepDays = page.getByRole("combobox", { name: "Keep mail for" });
  await keepDays.selectOption("30");
  await expect(error).toContainText(
    "The download setting could not be saved. Try again.",
  );
  await expect(keepDays).toHaveValue("90");

  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: /^Outbox/ }).click();
  const outbox = page.getByRole("region", { name: "Outbox" });
  await expect(outbox.getByText("Unsent for account-1")).toBeVisible();
  const outboxWrites = await page.evaluate(() => {
    const writes = new Set([
      "restore_outbox",
      "retry_outbox",
      "send_scheduled_outbox",
      "delete_outbox",
    ]);
    return window
      .__POSTAL_SNAP_TEST__!.ipcCalls.map((call) => call.command)
      .filter((command) => writes.has(command));
  });
  expect(outboxWrites).toEqual([]);

  const scopedCalls = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
      (call) =>
        call.command === "clear_account_downloads" ||
        call.command === "set_account_cache_policy",
    ),
  );
  expect(scopedCalls).toEqual([
    expect.objectContaining({
      command: "clear_account_downloads",
      args: { accountId: "account-1" },
    }),
    expect.objectContaining({
      command: "clear_account_downloads",
      args: { accountId: "account-1" },
    }),
    expect.objectContaining({
      command: "set_account_cache_policy",
      args: expect.objectContaining({
        accountId: "account-1",
        policy: expect.objectContaining({ mode: "recent", days: 30 }),
      }),
    }),
  ]);
});

test("Bridge certificate approval and removal stay scoped through account switching", async ({
  page,
}) => {
  await createLocalBridgeAccount(page);

  await page
    .getByRole("button", { name: "Import Bridge certificate", exact: true })
    .click();
  const fingerprint = "SHA-256: 12:34:56:78:90:AB:CD:EF";
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible();

  let approvalPrompt = "";
  page.once("dialog", (dialog) => {
    approvalPrompt = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Approve certificate" }).click();
  expect(approvalPrompt).toContain("Trust this public certificate only");
  expect(
    await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__!.ipcCalls.some(
        (call) => call.command === "approve_bridge_certificate",
      ),
    ),
  ).toBe(false);
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Approve certificate" }).click();
  await expect(
    page.getByText("Certificate approved", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove certificate" }),
  ).toBeVisible();
  const approvals = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
      (call) => call.command === "approve_bridge_certificate",
    ),
  );
  expect(approvals).toHaveLength(1);
  expect(approvals[0].args).toMatchObject({
    accountId: "account-1",
    reference: "bridge-certificate-fixture",
  });

  await page.getByRole("button", { name: "Back to accounts" }).click();
  await page.getByRole("button", { name: /^Manage Work\b/ }).click();
  await expect(
    page.getByRole("button", { name: "Import Bridge certificate" }),
  ).toHaveCount(0);
  await expect(page.getByText(fingerprint, { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__!.ipcCalls.some(
        (call) =>
          call.command === "get_account_cache_policy" &&
          call.args.accountId === "account-2",
      ),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Back to accounts" }).click();
  await page.getByRole("button", { name: /^Manage Local Bridge\b/ }).click();
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Remove certificate" }).click();
  expect(
    await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__!.ipcCalls.some(
        (call) => call.command === "remove_bridge_certificate",
      ),
    ),
  ).toBe(false);

  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const target = window as Window & {
      __removeCertificateDefault?: (args: Record<string, unknown>) => unknown;
    };
    target.__removeCertificateDefault = mock.handlers
      .remove_bridge_certificate as (args: Record<string, unknown>) => unknown;
    mock.handlers.remove_bridge_certificate = () => {
      throw mock.mockError(
        "localStorageFailed",
        "PRIVATE_CERTIFICATE_PATH /tmp/private-bridge-cert",
      );
    };
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove certificate" }).click();
  const failure = page.getByText(
    "Postal Snap could not access local mail data on your computer.",
    { exact: true },
  );
  await expect(failure).toContainText(
    "Postal Snap could not access local mail data on your computer.",
  );
  await expect(failure).not.toContainText("PRIVATE_CERTIFICATE_PATH");
  await expect(page.getByText(fingerprint, { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const target = window as Window & {
      __removeCertificateDefault?: (args: Record<string, unknown>) => unknown;
    };
    if (!target.__removeCertificateDefault)
      throw new Error("The default certificate removal mock is missing.");
    window.__POSTAL_SNAP_MOCK__!.handlers.remove_bridge_certificate =
      target.__removeCertificateDefault;
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove certificate" }).click();
  await expect(page.getByText(fingerprint, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove certificate" }),
  ).toHaveCount(0);
  const removals = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
      (call) => call.command === "remove_bridge_certificate",
    ),
  );
  expect(removals).toHaveLength(2);
  expect(removals.every((call) => call.args.accountId === "account-1")).toBe(
    true,
  );
});
