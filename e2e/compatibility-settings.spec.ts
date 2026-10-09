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

test("connection settings show loading, retry a failed read, then recover", async ({
  page,
}) => {
  await page.goto("/?connectionLoadFailure=1&slowAccountLoads=1");
  await openAccount(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toHaveText(
    "Loading connection settings…",
  );
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText("could not access local mail data");
  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Incoming IMAP" }),
  ).toBeVisible();
});

test("folder assignments show loading, retry a failed read, then recover", async ({
  page,
}) => {
  await page.goto("/?folderLoadFailure=1&slowAccountLoads=1");
  await openAccount(page);
  await page.getByRole("button", { name: "Folders", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toHaveText(
    "Loading folder assignments…",
  );
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText("could not access local mail data");
  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Sent folder", { exact: true })).toBeVisible();
});

for (const endpoint of ["Incoming IMAP", "Outgoing SMTP"] as const) {
  test(`${endpoint} test failure gives endpoint-specific recovery guidance`, async ({
    page,
  }) => {
    const failureParameter =
      endpoint === "Incoming IMAP"
        ? "failIncomingConnection"
        : "failOutgoingConnection";
    await page.goto(`/?${failureParameter}=1`);
    await openAccount(page);
    const group = page.getByRole("group", { name: endpoint });
    await group
      .getByLabel("Port")
      .fill(endpoint === "Incoming IMAP" ? "1993" : "1587");
    await page
      .getByRole("button", { name: "Test and save", exact: true })
      .click();
    const status = page.getByRole("dialog").getByRole("status");
    await expect(status).toContainText(endpoint);
    await expect(status).toContainText(
      endpoint === "Incoming IMAP"
        ? "Check imap.mail.me.com, port 993"
        : "Check smtp.mail.me.com, port 587",
    );
    await expect(status).not.toContainText("fixture-private-secret");
  });
}

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
      `/?noAccounts=1&bridgeCertificateFail=1${outcome === "cancel" ? "&certificateCancel=1" : ""}`,
    );
    await page.getByRole("button", { name: /Proton Bridge/ }).click();
    await page
      .getByRole("button", { name: "Import Bridge certificate", exact: true })
      .click();
    if (outcome !== "cancel") {
      await expect(page.getByText(/SHA-256/i).first()).toBeVisible();
      await expect(page.getByText(/2098|2099/).first()).toBeVisible();
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
  await page.goto("/?noAccounts=1");
  await page.getByRole("button", { name: /Proton Bridge/ }).click();
  await expect(page.getByText(/Bridge must remain running/)).toBeVisible();
  await page.getByLabel("Your name").fill("Bridge reader");
  page.once("dialog", (dialog) => dialog.accept());
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

for (const stage of ["imap", "smtp"] as const) {
  test(`Bridge ${stage.toUpperCase()} certificate failure names its endpoint`, async ({
    page,
  }) => {
    await page.goto(
      `/?noAccounts=1&bridgeCertificateFail=1&certificateFailureStage=${stage}`,
    );
    await page.getByRole("button", { name: /Proton Bridge/ }).click();
    await page.getByLabel("Your name").fill("Bridge reader");
    page.once("dialog", (dialog) => dialog.accept());
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
    const failure = page.getByRole("alert");
    await expect(failure).toContainText(
      stage === "imap"
        ? "Incoming IMAP certificate verification failed"
        : "Outgoing SMTP certificate verification failed",
    );
    await expect(failure).toContainText(
      "Export the public TLS certificate from Bridge settings",
    );
    await expect(failure).not.toContainText("fixture-private-secret");
    await expect(failure).not.toContainText("Bridge must remain running");
  });
}

test("Bridge setup storage failures do not suggest Bridge is unavailable", async ({
  page,
}) => {
  await page.goto("/?noAccounts=1&setupStorageFail=1");
  await page.getByRole("button", { name: /Proton Bridge/ }).click();
  await page.getByLabel("Your name").fill("Bridge reader");
  page.once("dialog", (dialog) => dialog.accept());
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
  const failure = page.getByRole("alert");
  await expect(failure).toContainText("could not access local mail data");
  await expect(failure).not.toContainText("Bridge must remain running");
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
    for (const theme of ["light", "dark"]) {
      for (const width of [720, 1400]) {
        test(`settings fit ${density} ${scale}% ${theme} ${width}px`, async ({
          page,
        }, testInfo) => {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `/?density=${density}&scale=${scale / 100}&theme=${theme}`,
          );
          await page
            .getByRole("button", { name: "Settings", exact: true })
            .click();
          if (width < 760)
            await page
              .getByLabel("Settings section", { exact: true })
              .selectOption("appearance");
          else
            await page
              .getByRole("tab", { name: "Appearance", exact: true })
              .click();
          await expect(
            page.getByLabel("Text size", { exact: true }),
          ).toHaveValue(String(scale / 100));
          await expect(page.locator("html")).toHaveAttribute(
            "data-density",
            density,
          );
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
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
  }
}

for (const navigation of ["search", "keyboard"] as const) {
  test(`dirty connection survives canceled ${navigation} navigation`, async ({
    page,
  }) => {
    await page.goto("/");
    await openAccount(page);
    const port = page
      .getByRole("group", { name: "Incoming IMAP" })
      .getByLabel("Port");
    await port.fill("1993");
    page.once("dialog", (dialog) => dialog.dismiss());
    if (navigation === "search")
      await page
        .getByRole("searchbox", { name: "Search settings" })
        .fill("appearance");
    else {
      await page.getByRole("tab", { name: "Accounts", exact: true }).focus();
      await page.keyboard.press("ArrowDown");
    }
    await expect(port).toHaveValue("1993");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(port).toBeVisible();
  });
}

for (const mode of ["forced colors", "reduced motion"] as const) {
  test(`settings and account controls support ${mode}`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia(
      mode === "forced colors"
        ? { forcedColors: "active" }
        : { reducedMotion: "reduce" },
    );
    await page.goto("/?scale=2&density=compact");
    await openAccount(page);
    const port = page
      .getByRole("group", { name: "Incoming IMAP" })
      .getByLabel("Port");
    await port.focus();
    await expect(port).toBeFocused();
    expect(
      await page
        .locator(".settings-window")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await testInfo.attach("settings-accessibility", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

test("connection identity repair explains pending work", async ({ page }) => {
  await page.goto("/?multiAccount=1&pendingConnectionWork=1");
  await openAccount(page, "Work");
  await page
    .getByRole("group", { name: "Incoming IMAP" })
    .getByLabel("Server", { exact: true })
    .fill("imap.other.example");
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Test and save", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /2 queued changes.*1 unsent message/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open this account’s Outbox", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Outbox", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Unsent for account-2", { exact: true }),
  ).toBeVisible();
});

test("invalid certificate import explains required public certificate", async ({
  page,
}) => {
  await page.goto("/?noAccounts=1&invalidCertificate=1");
  await page.getByRole("button", { name: /Proton Bridge/ }).click();
  await page
    .getByRole("button", { name: "Import Bridge certificate", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "valid, unexpired public PEM certificate",
  );
});

test("account list explains connection status in plain language", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Manage Sam", exact: true }),
  ).toContainText("Mail is up to date");
});

test("search focuses asynchronously loaded account signature", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search settings" })
    .fill("signature");
  await page.getByRole("button", { name: /Email signature.*Accounts/ }).click();
  await expect(
    page.getByLabel("Email signature", { exact: true }),
  ).toBeFocused();
});

test("search includes account format and update cadence", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search settings" });
  await search.fill("plain text");
  await page
    .getByRole("button", { name: /New messages start as.*Accounts/ })
    .click();
  await expect(
    page.getByLabel("New messages start as", { exact: true }),
  ).toBeFocused();
  await search.fill("cadence");
  await page
    .getByRole("button", { name: /Check for updates.*Updates/ })
    .click();
  await expect(
    page.getByLabel("Check for updates", { exact: true }),
  ).toBeFocused();
});
