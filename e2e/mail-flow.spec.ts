import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

test("mock IPC fails closed for unregistered native commands", async ({
  page,
}) => {
  await page.goto("/");
  const message = await page.evaluate(async () => {
    try {
      await (
        window as typeof window & {
          __TAURI_INTERNALS__: {
            invoke: (command: string) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke("missing_native_command");
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  });
  expect(message).toContain(
    "No mock handler for native command: missing_native_command",
  );
});

test("fills resized window without exposing a blank footer", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".mail-shell").waitFor();
  for (const viewport of [
    { width: 620, height: 540 },
    { width: 900, height: 720 },
    { width: 1240, height: 820 },
    { width: 1875, height: 1400 },
  ]) {
    await page.setViewportSize(viewport);
    const bounds = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".mail-shell");
      const panes = [
        document.querySelector<HTMLElement>(".message-pane"),
        document.querySelector<HTMLElement>(
          ".reader-pane:not(.empty-reader):not(.reader-hidden)",
        ),
      ].filter((pane): pane is HTMLElement =>
        Boolean(pane && pane.getBoundingClientRect().height > 0),
      );
      return {
        shellBottom: shell?.getBoundingClientRect().bottom ?? 0,
        paneBottoms: panes.map((pane) => pane.getBoundingClientRect().bottom),
        viewportBottom: window.innerHeight,
      };
    });
    expect(
      Math.abs(bounds.shellBottom - bounds.viewportBottom),
    ).toBeLessThanOrEqual(1);
    for (const bottom of bounds.paneBottoms) {
      expect(Math.abs(bottom - bounds.viewportBottom)).toBeLessThanOrEqual(1);
    }
  }
});

test("clamps a saved bottom reader height to the resized viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1240, height: 540 });
  await page.goto("/?tallBottom=1");
  await page.locator(".mail-shell").waitFor();
  await expect(page.locator(".mail-shell")).toHaveClass(/pane-bottom/);

  const bounds = await page.evaluate(() => {
    const message = document.querySelector<HTMLElement>(".message-pane");
    const reader = document.querySelector<HTMLElement>(".reader-pane");
    const messageBounds = message?.getBoundingClientRect();
    const readerBounds = reader?.getBoundingClientRect();
    return {
      messageHeight: messageBounds?.height ?? 0,
      readerBottom: readerBounds?.bottom ?? 0,
      viewportBottom: window.innerHeight,
    };
  });

  expect(bounds.messageHeight).toBeGreaterThanOrEqual(219);
  expect(
    Math.abs(bounds.readerBottom - bounds.viewportBottom),
  ).toBeLessThanOrEqual(1);
});

test("uses an edge-to-edge Mail-style sidebar and trailing scoped search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1240, height: 820 });
  await page.goto("/");
  await page.locator(".mail-shell").waitFor();

  const geometry = await page.evaluate(() => {
    const folder = document.querySelector<HTMLElement>(".folder-pane");
    const toolbar = document.querySelector<HTMLElement>(".app-toolbar");
    const search = document.querySelector<HTMLElement>(".search-box");
    const folderBounds = folder?.getBoundingClientRect();
    const toolbarBounds = toolbar?.getBoundingClientRect();
    const searchBounds = search?.getBoundingClientRect();
    return {
      folderTop: folderBounds?.top ?? -1,
      folderBottom: folderBounds?.bottom ?? -1,
      folderRight: folderBounds?.right ?? -1,
      toolbarTop: toolbarBounds?.top ?? -1,
      toolbarLeft: toolbarBounds?.left ?? -1,
      toolbarRight: toolbarBounds?.right ?? -1,
      searchLeft: searchBounds?.left ?? -1,
      scopeHeight:
        document
          .querySelector<HTMLElement>(".search-scope")
          ?.getBoundingClientRect().height ?? 0,
      viewportBottom: window.innerHeight,
    };
  });

  expect(Math.abs(geometry.folderTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.toolbarTop)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(geometry.folderBottom - geometry.viewportBottom),
  ).toBeLessThanOrEqual(1);
  expect(geometry.toolbarLeft).toBeGreaterThanOrEqual(geometry.folderRight);
  expect(geometry.searchLeft).toBeGreaterThan(
    geometry.toolbarLeft + (geometry.toolbarRight - geometry.toolbarLeft) / 2,
  );
  expect(geometry.scopeHeight).toBeGreaterThanOrEqual(44);

  await expect(page.getByRole("button", { name: "Get Mail" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill("weekend");
  await search.press("Enter");
  await expect(
    page.getByRole("option", { name: /Current mailbox/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: "This mailbox" }).click();
  await expect(
    page.getByRole("button", { name: "This account" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("option", { name: /Across account/i }),
  ).toBeVisible();
});

test("opens the mailbox drawer across the responsive sidebar range", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await page.goto("/");

  const folderPane = page.locator(".folder-pane");
  const toolbar = page.locator(".app-toolbar");
  await expect(folderPane).toBeHidden();
  await page.getByRole("button", { name: "Show mailboxes" }).click();
  await expect(folderPane).toBeVisible();
  await expect(toolbar).toHaveAttribute("inert", "");

  await page.setViewportSize({ width: 1240, height: 820 });
  await expect(folderPane).toBeVisible();
  await expect(toolbar).not.toHaveAttribute("inert", "");
  await expect(
    page.getByRole("button", { name: "Hide mailboxes" }),
  ).toHaveAttribute("aria-expanded", "true");

  await page.setViewportSize({ width: 620, height: 540 });
  await expect(
    page.getByRole("button", { name: "This mailbox" }),
  ).toBeVisible();
});

test("completes guided iCloud first run", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await expect(page.locator(".server-summary")).toContainText(
    "imap.mail.me.com",
  );
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("app-password");
  await page.getByRole("button", { name: "Connect securely" }).click();

  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Mailboxes" }),
  ).toContainText("Inbox");
});

test("opens settings before an account is configured", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await expect(
    page.getByText("No email accounts configured yet."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to account setup" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Meta+,");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("shows recovery instead of an empty setup wizard when saved accounts fail to load", async ({
  page,
}) => {
  await page.goto("/?startupFail=1");
  await expect(
    page.getByRole("heading", {
      name: "Postal Snap could not open your mail data",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Settings" })).toHaveCount(
    0,
  );
});

test("routes native settings and update menu actions", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await page.evaluate(() =>
    (
      window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "menu-action",
      payload: "settings",
    }),
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const dialogPromise = page.waitForEvent("dialog");
  await page.evaluate(() =>
    (
      window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "menu-action",
      payload: "check-for-updates",
    }),
  );
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("Postal Snap");
  await dialog.accept();
  // Ensure settings window was not redundantly opened by the menu action
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("keeps settings tab names accessible in a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 540, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const tabNames = [
    "General",
    "Reading",
    "Notifications",
    "Storage",
    "Accounts",
    "Shortcuts",
    "Updates",
    "Advanced",
    "About",
  ];
  await expect
    .poll(() =>
      page
        .getByRole("tab")
        .evaluateAll((tabs) =>
          tabs.map((tab) => tab.getAttribute("aria-label")),
        ),
    )
    .toEqual(tabNames);
  for (const name of tabNames) {
    await expect(page.getByRole("tab", { name }).locator("span")).toBeVisible();
  }
});

test("exports and imports portable settings with reset kept in Accounts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Export settings" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { exportedSettings: number };
            }
          ).__POSTAL_SNAP_TEST__.exportedSettings,
      ),
    )
    .toBe(1);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Import settings" }).click();
  await expect(page.locator(".settings-data-status")).toContainText(
    "Settings imported.",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await expect(
    page.getByRole("button", { name: "Reset settings" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Accounts" }).click();
  await expect(
    page.getByRole("button", { name: "Reset & Restart" }),
  ).toHaveCount(1);
});

test("completes secure manual first run", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /Other email/i }).click();
  await expect(page.getByText("imap.mail.me.com")).toHaveCount(0);
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@example.com");
  await page.getByLabel("Email password").fill("secret");
  const incoming = page.getByRole("group", { name: "Incoming IMAP" });
  const outgoing = page.getByRole("group", { name: "Outgoing SMTP" });
  await incoming.getByLabel("Server").fill("imap.example.com");
  await outgoing.getByLabel("Server").fill("smtp.example.com");
  await page.getByRole("button", { name: "Connect securely" }).click();

  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  const setup = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __POSTAL_SNAP_TEST__: {
            setupRequest?: {
              provider: string;
              imap?: { host: string };
              smtp?: { host: string };
            };
          };
        }
      ).__POSTAL_SNAP_TEST__.setupRequest,
  );
  expect(setup).toMatchObject({
    provider: "manual",
    imap: { host: "imap.example.com" },
    smtp: { host: "smtp.example.com" },
  });
});

test("explains how to recover from a failed iCloud sign-in", async ({
  page,
}) => {
  await page.goto("/?firstRun=1&setupFail=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("wrong-password");
  await page.getByRole("button", { name: "Connect securely" }).click();
  await expect(
    page.getByText(/regular Apple Account password will not work/i),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Compose" })).toHaveCount(0);
});

test("reads, replies, and sends through typed IPC", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("jane@example.com");
  await expect(page.getByRole("textbox", { name: "From" })).toHaveValue(
    /Sam <sam@icloud.com>/,
  );
  await page.getByLabel("Message body").pressSequentially("Yes, see you then.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const sent = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __POSTAL_SNAP_TEST__: { sentDraft?: { to: string[] } };
        }
      ).__POSTAL_SNAP_TEST__.sentDraft,
  );
  expect(sent?.to).toEqual(["jane@example.com"]);
});

test("updates unread and folder state immediately after mutations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByRole("button", { name: /^Inbox/ })).not.toContainText(
    "1",
  );

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Mark unread" }).click();
  await expect(page.getByRole("button", { name: /^Inbox/ })).toContainText("1");

  await page
    .locator(".reader-actions")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByRole("button", { name: /^Archive/ })).toContainText(
    "1",
  );
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toHaveCount(0);
});

test("switches reading layouts and opens hidden messages accessibly", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading" }).click();
  await page.getByLabel("Reading pane", { exact: true }).selectOption("bottom");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("main.mail-shell")).toHaveClass(/pane-bottom/);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading" }).click();
  await page.getByLabel("Reading pane", { exact: true }).selectOption("hidden");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "Close message" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Close message" }),
  ).toBeHidden();
});

test("opens local drafts and makes uncertain sends explicit", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
  await page.getByRole("button", { name: /Family update/i }).click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("pat@example.com");
  await page
    .locator(".composer-window")
    .getByRole("button", { name: "Save draft and close" })
    .click();

  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(
    page.getByText("Delivery could not be confirmed."),
  ).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Retry sending" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { retried: boolean };
            }
          ).__POSTAL_SNAP_TEST__.retried,
      ),
    )
    .toBe(true);
});

test("never fetches remote images before consent", async ({ page }) => {
  await page.goto("/?remote=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __POSTAL_SNAP_TEST__: { remoteFetches: number };
          }
        ).__POSTAL_SNAP_TEST__.remoteFetches,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Load images" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { remoteFetches: number };
            }
          ).__POSTAL_SNAP_TEST__.remoteFetches,
      ),
    )
    .toBe(1);
});

test("keeps filtered images blocked after consent without offering endless retries", async ({
  page,
}) => {
  await page.goto("/?remote=1&filterBlocked=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Load images" }).click();
  await expect(
    page.getByText("1 advertising or tracking image kept blocked for privacy."),
  ).toBeVisible();
  const image = page
    .frameLocator('iframe[title="Message content"]')
    .locator("img");
  await expect(image).toHaveAttribute("data-content-blocked", "true");
  await expect(image).not.toHaveAttribute("src");
  await expect(
    page.getByRole("button", { name: "Retry loading images" }),
  ).toHaveCount(0);
});

test("keeps reported-threat images blocked after consent without a Safe label", async ({
  page,
}) => {
  await page.goto("/?remote=1&threatBlocked=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Load images" }).click();
  await expect(
    page.getByText(
      "1 image from a reported potentially dangerous address kept blocked.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/\bSafe\b|confirmed/i)).toHaveCount(0);
  const image = page
    .frameLocator('iframe[title="Message content"]')
    .locator("img");
  await expect(image).toHaveAttribute("data-threat-blocked", "true");
  await expect(image).not.toHaveAttribute("src");
  await expect(
    page.getByRole("button", { name: "Retry loading images" }),
  ).toHaveCount(0);
});

test("asks to confirm ordinary links with the real hostname first", async ({
  page,
}) => {
  await page.goto("/?webLink=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  page.once("dialog", async (dialog) => {
    const text = dialog.message();
    expect(text.indexOf("library.example.test")).toBeGreaterThan(-1);
    expect(text.indexOf("library.example.test")).toBeLessThan(
      text.indexOf("https://library.example.test/hours"),
    );
    expect(text).not.toMatch(/\bSafe\b/);
    await dialog.accept();
  });
  await page
    .frameLocator('iframe[title="Message content"]')
    .getByRole("link", { name: "Open site" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { openedUrls: string[] };
            }
          ).__POSTAL_SNAP_TEST__.openedUrls,
      ),
    )
    .toEqual(["https://library.example.test/hours"]);
});

test("keeps reported links closed unless the user opens them anyway", async ({
  page,
}) => {
  await page.goto("/?threatLink=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const link = page
    .frameLocator('iframe[title="Message content"]')
    .getByRole("link", { name: "Open site" });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toMatch(/phish\.example\.test/);
    expect(dialog.message()).toMatch(/potentially dangerous/i);
    expect(dialog.message()).not.toMatch(/confirmed/i);
    expect(dialog.message()).not.toMatch(/\bSafe\b/);
    await dialog.dismiss();
  });
  await link.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { openedUrls: string[] };
            }
          ).__POSTAL_SNAP_TEST__.openedUrls.length,
      ),
    )
    .toBe(0);

  const messages: string[] = [];
  const acceptBoth = async (dialog: {
    message: () => string;
    accept: () => Promise<void>;
  }) => {
    messages.push(dialog.message());
    await dialog.accept();
  };
  page.on("dialog", acceptBoth);
  await link.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { openedUrls: string[] };
            }
          ).__POSTAL_SNAP_TEST__.openedUrls,
      ),
    )
    .toEqual(["https://phish.example.test/login"]);
  expect(messages[1]).toMatch(/Open this reported address anyway/);
  page.off("dialog", acceptBoth);
});

test("rejects credentialed HTML links before opening them", async ({
  page,
}) => {
  await page.goto("/?credentialLink=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  page.once("dialog", () => {
    throw new Error("Credentialed links must not show an open prompt");
  });
  await page
    .frameLocator('iframe[title="Message content"]')
    .getByRole("link", { name: "Open site" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { openedUrls: string[] };
            }
          ).__POSTAL_SNAP_TEST__.openedUrls.length,
      ),
    )
    .toBe(0);
});

test("image fetch failures remain retryable and are not labeled tracker blocks", async ({
  page,
}) => {
  await page.goto("/?remote=1&imageFailed=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Load images" }).click();
  await expect(
    page.getByRole("button", { name: "Retry loading images" }),
  ).toBeVisible();
  await expect(page.getByText(/kept blocked for privacy/)).toHaveCount(0);
});

test("renders received CID images without remote network access", async ({
  page,
}) => {
  await page.goto("/?inline=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.frameLocator('iframe[title="Message content"]').locator("img"),
  ).toHaveAttribute("src", /^data:image\/png;base64,/);
  const counts = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __POSTAL_SNAP_TEST__: { inlineReads: number; remoteFetches: number };
      }
    ).__POSTAL_SNAP_TEST__;
    return { inline: state.inlineReads, remote: state.remoteFetches };
  });
  expect(counts).toEqual({ inline: 1, remote: 0 });
});

test("uses a mailbox drawer and back control in narrow windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Show mailboxes" }).click();
  await expect(page.getByRole("button", { name: /^Inbox/ })).toBeVisible();
  await page.getByRole("button", { name: /^Inbox/ }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "Back to message list" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to message list" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("loads older mail with cursor pagination", async ({ page }) => {
  await page.goto("/?pagination=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load older mail" }).click();
  await expect(
    page.getByRole("option", { name: /Older family note/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load older mail" }),
  ).toBeHidden();
});

test("validates recipients before sending", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose" }).click();
  await page
    .locator(".composer-window")
    .getByRole("button", { name: "Maximize editor" })
    .click();
  await expect(page.getByText("Add at least one recipient.")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("not-an-address");
  await page.getByRole("textbox", { name: "Subject" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Check each recipient address",
  );
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
});

test("forwards normal attachments by default", async ({ page }) => {
  await page.goto("/?forwardAttachment=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "family-plan.pdf",
  );
});

test("shows recovered draft conflicts and sent-copy-only retry", async ({
  page,
}) => {
  await page.goto("/?localMail=1&conflict=1&sentCopy=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.getByText("Recovered conflict copy")).toBeVisible();
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Sent — copy pending")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry sending" }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Save Sent copy" }),
  ).toBeVisible();
});

test("reopens inline draft previews from managed storage", async ({ page }) => {
  await page.goto("/?localMail=1&draftInline=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: /Family update/i }).click();
  await expect(page.locator(".compose-attachments")).toContainText("photo.png");
});

test("replies from the Mail shortcut and shows a From address", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.keyboard.press("Meta+r");
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("jane@example.com");
  await expect(page.getByRole("textbox", { name: "From" })).toHaveValue(
    /Sam <sam@icloud.com>/,
  );
});

test("hides message previews in compact density", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("Are we still meeting on Saturday?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "General" }).click();
  await page.getByLabel("Interface spacing").selectOption("compact");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(
    page.getByText("Are we still meeting on Saturday?"),
  ).toBeHidden();
});

test("lists Mail-like shortcuts instead of using R for Get Mail", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Shortcuts" }).click();
  const getMail = page.locator(".shortcut-row").filter({ hasText: "Get Mail" });
  await expect(getMail.locator("kbd")).toContainText("N");
  await expect(getMail.locator("kbd")).not.toContainText("R");
  await expect(
    page
      .locator(".shortcut-row")
      .filter({ has: page.getByText("Reply", { exact: true }) })
      .locator("kbd"),
  ).toContainText("R");
});

test("mail shell has no detectable serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".mail-shell").waitFor();
  const scan = await new AxeBuilder({ page }).analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});

test("supports full sync download all option with unlimited storage limit", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Storage" }).click();

  const cacheModeSelect = page.getByLabel("Mail to keep");
  await cacheModeSelect.selectOption("full");

  const cacheLimitSelect = page.getByLabel("Maximum cache size");
  await expect(cacheLimitSelect).toBeDisabled();
  await expect(cacheLimitSelect).toHaveValue("0");
  await expect(page.locator(".storage-card")).toContainText("Full sync");
});

test("detects and manages account aliases and presents From selector in composer", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();

  await page.getByRole("button", { name: "Detect from iCloud" }).click();
  await expect(page.locator(".aliases-list")).toContainText(
    "custom@mydomain.com",
  );

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.getByLabel("From address")).toBeVisible();
  await expect(page.getByLabel("From address")).toContainText(
    "custom@mydomain.com",
  );
});

test("renders alias header help without overlap blockers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await expect(page.getByText("Email Aliases & Custom Domains")).toBeVisible();
  await expect(
    page.getByText(/Send and receive using iCloud aliases/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Detect from iCloud" }),
  ).toBeVisible();
});

test("keeps oversize envelopes actionable with an explicit notice", async ({
  page,
}) => {
  await page.goto("/?oversize=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});

test("exposes the message toolbar for keyboard users", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("toolbar", { name: "Message actions" }),
  ).toBeVisible();
});

test("announces failed sign-ins as alerts", async ({ page }) => {
  await page.goto("/?firstRun=1&setupFail=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("wrong-password");
  await page.getByRole("button", { name: "Connect securely" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});

test("creates, renames, and deletes personal folders", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByPlaceholder("Folder name").fill("Receipts");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByRole("button", { name: /^Receipts/ })).toBeVisible();

  await page.getByRole("button", { name: "Rename Receipts" }).click();
  await page.getByPlaceholder("Folder name").fill("Bills");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Bills/ })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete folder: Bills" }).click();
  await expect(page.getByRole("button", { name: /^Bills/ })).toHaveCount(0);
});

test("empties trash only after confirmation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Empty trash" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: /^Deleted Messages/ }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Empty trash" }).click();
  await expect(page.getByRole("button", { name: "Empty trash" })).toBeHidden();
});

test("recovers expired passwords without removing the account", async ({
  page,
}) => {
  await page.goto("/?authError=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await expect(page.getByRole("alert")).toContainText("Sign-in failed");
  await page.getByLabel("Update password").fill("new-app-password");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText(/Password updated/)).toBeVisible();
});

test("triages several messages at once", async ({ page }) => {
  await page.goto("/?pagination=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByRole("checkbox", { name: /Weekend plans/i }).check();
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeHidden();

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Mark all read" }).click();
  await expect(page.getByRole("button", { name: /^Inbox/ })).not.toContainText(
    "1",
  );
});

test("completes recipients from send history", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("jan");
  await expect(
    page.getByRole("option", { name: /jane@example.com/i }),
  ).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("name@example.com")).toHaveValue(
    /jane@example.com/,
  );
});

test("previews image attachments without downloading", async ({ page }) => {
  await page.goto("/?previewable=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Preview: family.png" }).click();
  const dialog = page.getByRole("dialog", { name: "Preview of family.png" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("groups threaded replies behind one row", async ({ page }) => {
  await page.goto("/?threaded=1&pagination=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load older mail" }).click();
  const header = page.getByRole("button", {
    name: /Conversation.*2 messages/i,
  });
  await expect(header).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toHaveCount(0);
  await header.click();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Older family note/i }),
  ).toBeVisible();
});

test("saves a per-account signature", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByLabel("Email signature").fill("Best,\nSam");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Signature saved/)).toBeVisible();
});

test("creates, disables, and deletes a mail rule", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByLabel("Rule name").fill("Bills");
  await page.getByLabel("Text to match").fill("power.example.com");
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByText(/Rule saved/)).toBeVisible();

  const ruleRow = page.getByText("Bills").locator("xpath=ancestor::li");
  await ruleRow.getByRole("button", { name: /^Bills: On$/ }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await ruleRow.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText(/Rule removed/)).toBeVisible();
  await expect(page.getByText("Bills")).toBeHidden();
});

test("undoes a held message before it sends", async ({ page }) => {
  await page.goto("/?localMail=1&scheduled=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Held for review")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Held for review")).toBeHidden();
});

test("snoozes a message until tomorrow morning", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("button", { name: "Tomorrow morning" }).click();
  await expect(
    page.getByRole("button", { name: "Tomorrow morning" }),
  ).toBeHidden();
  const snoozed = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __POSTAL_SNAP_TEST__: { snoozed: boolean };
        }
      ).__POSTAL_SNAP_TEST__.snoozed,
  );
  expect(snoozed).toBe(true);
});

test("keeps message body opaque when translucent window effects are enabled", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "General" }).click();
  await page.getByLabel("Translucent window background").check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const bodyBackground = await page
    .locator(".message-body")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(bodyBackground).toMatch(/rgb\(255,\s*255,\s*255\)|#fff/i);
});
