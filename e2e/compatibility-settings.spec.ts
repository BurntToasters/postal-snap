import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

// Failures: unapproved trust, lost connection state, cross-account folders,
// stale folder targets, unusable search, and discarded connection edits.
async function openAccount(
  page: import("@playwright/test").Page,
  name = "Sam",
) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page
    .getByRole("button", { name: `Manage ${name}`, exact: true })
    .click();
}

test("settings search clears and reports no matches", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search settings" })
    .fill("zz-no-setting");
  await expect(
    page.getByText("No settings found", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search settings" }),
  ).toHaveValue("");
  await expect(
    page.getByRole("tab", { name: "General", exact: true }),
  ).toBeVisible();
});

test("failed connection testing retains saved connection", async ({ page }) => {
  await page.goto("/?failConnection=1");
  await openAccount(page);
  const port = page
    .getByRole("group", { name: "Incoming IMAP" })
    .getByLabel("Port");
  await port.fill("1993");
  await page
    .getByRole("button", { name: "Test and save", exact: true })
    .click();
  await expect(page.getByText(/Connection test failed/).first()).toBeVisible();
  expect(
    await page.evaluate(async () =>
      window.__POSTAL_SNAP_MOCK__!.handlers.get_account_connection({
        accountId: "account-1",
      }),
    ),
  ).toMatchObject({ imap: { port: 993 } });
});

test("folder assignments stay isolated and return to automatic", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&nestedFolders=1");
  await openAccount(page);
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  const sent = page.getByLabel("Sent folder", { exact: true });
  expect(
    await sent
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).not.toContain("21");
  await sent.selectOption("4");
  await sent.selectOption("");
  await expect(sent).toHaveValue("");
  const calls = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
      (call) => call.command === "set_folder_assignment",
    ),
  );
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.args.accountId === "account-1")).toBe(true);
});

test("missing folder assignment requires explicit repair", async ({ page }) => {
  await page.goto("/?missingFolder=1");
  await openAccount(page);
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await expect(page.getByText(/needs attention/i).first()).toBeVisible();
  await page.getByLabel("Sent folder", { exact: true }).selectOption("");
  await expect(page.getByText(/needs attention/i)).toHaveCount(0);
});

for (const outcome of ["approve", "reject", "cancel"] as const) {
  test(`Bridge certificate import ${outcome} requires deliberate trust`, async ({
    page,
  }) => {
    await page.goto(
      `/?firstRun=1&bridgeCertificateFail=1${outcome === "cancel" ? "&certificateCancel=1" : ""}`,
    );
    await page.getByRole("button", { name: /Proton Bridge/ }).click();
    await page
      .getByRole("button", { name: "Import Bridge certificate", exact: true })
      .click();
    if (outcome !== "cancel") {
      await expect(page.getByText(/SHA-256/i).first()).toBeVisible();
      await expect(page.getByText(/2099/).first()).toBeVisible();
      page.once("dialog", (dialog) =>
        outcome === "approve" ? dialog.accept() : dialog.dismiss(),
      );
      await page
        .getByRole("button", { name: "Approve certificate", exact: true })
        .click();
    }
    const calls = await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
        (call) => call.command === "approve_bridge_certificate",
      ),
    );
    expect(calls).toHaveLength(outcome === "approve" ? 1 : 0);
    if (outcome === "approve")
      await expect(
        page.getByText(/Certificate approved/i).first(),
      ).toBeVisible();
  });
}

test("offers experimental Bridge setup with local TLS endpoints", async ({
  page,
}, testInfo) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: /Proton Bridge/ }).click();
  await expect(page.getByText(/Bridge must remain running/)).toBeVisible();
  await page
    .getByLabel("Email address", { exact: true })
    .fill("reader@custom.example");
  await page
    .getByLabel("Bridge password", { exact: true })
    .fill("synthetic-bridge-password");
  await page
    .getByRole("group", { name: "Incoming IMAP" })
    .getByLabel("Username")
    .fill("reader@custom.example");
  await page
    .getByRole("group", { name: "Outgoing SMTP" })
    .getByLabel("Username")
    .fill("reader@custom.example");
  await page.getByRole("button", { name: "Connect securely" }).click();
  await expect(
    page.getByRole("button", { name: "Open mailbox" }),
  ).toBeVisible();
  const request = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.setupRequest,
  );
  expect(request).toMatchObject({
    provider: "protonBridge",
    imap: { host: "127.0.0.1", tlsMode: "startTls" },
    smtp: { host: "127.0.0.1", tlsMode: "startTls" },
  });
  await testInfo.attach("bridge-setup", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("search opens and focuses the appearance control", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search settings" })
    .fill("text size");
  await page.getByRole("button", { name: /Text size.*Appearance/ }).click();
  await expect(page.getByLabel("Text size", { exact: true })).toBeFocused();
});

test("account pages isolate editable connections and folder assignments", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&nestedFolders=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: /Manage Sam/ }).click();
  await expect(
    page.getByRole("button", { name: "Back to accounts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Test and save" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await expect(page.getByLabel("Sent folder", { exact: true })).toHaveValue("");
  await page.getByLabel("Sent folder", { exact: true }).selectOption("4");
  await expect(
    page.getByRole("status").filter({ hasText: "Folder assignment saved" }),
  ).toBeVisible();
});

test("unsaved connection changes require confirmation before leaving", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: /Manage Sam/ }).click();
  await page
    .getByRole("group", { name: "Incoming IMAP" })
    .getByLabel("Port")
    .fill("1993");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Back to accounts" }).click();
  await expect(
    page.getByRole("button", { name: "Test and save" }),
  ).toBeVisible();
});

for (const density of ["comfortable", "compact"]) {
  for (const scale of [100, 200]) {
    test(`settings fit ${density} at ${scale}%`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 720, height: 900 });
      await page.goto(`/?density=${density}&textScale=${scale / 100}`);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(
        page.getByLabel("Settings section", { exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("Settings section", { exact: true })
        .selectOption("appearance");
      await expect(page.getByLabel("Text size", { exact: true })).toBeVisible();
      expect(
        await page
          .locator(".settings-window")
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      ).toBe(true);
      await testInfo.attach("settings-layout", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  }
}
