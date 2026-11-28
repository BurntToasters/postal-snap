import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, emitTauriEvent, ipcCalls } from "./ipc";

test.afterEach(attachArtifactsAfterEach);
test.beforeEach(async ({ page }) => installMockIpc(page));

test("B1-B3 app-specific password discovery handles Gmail, Outlook, iCloud+, and Fastmail", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.getByRole("dialog", { name: "Add email account" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: /Other email/i }).click();
  const emailField = dialog.getByLabel("Email address");
  const imapServer = dialog
    .getByRole("group", { name: "Incoming IMAP" })
    .getByLabel("Server");

  await emailField.fill("reader@gmail.com");
  await dialog.getByRole("button", { name: "Find settings" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Connect Gmail" }),
  ).toBeVisible();
  await expect(dialog.getByText(/2-Step Verification/)).toBeVisible();
  await expect(dialog.getByLabel(/App-specific password/i)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /OAuth|Sign in with Google/i }),
  ).toHaveCount(0);
  if (!(await imapServer.isVisible())) {
    await dialog.getByText("Review or edit server settings").click();
  }
  await expect(imapServer).toHaveValue("imap.gmail.com");
  await expect(
    dialog.getByRole("group", { name: "Outgoing SMTP" }).getByLabel("Server"),
  ).toHaveValue("smtp.gmail.com");

  await emailField.fill("reader@outlook.com");
  await dialog.getByRole("button", { name: "Find settings" }).click();
  await expect(dialog.getByText(/Outlook requires OAuth/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Connect Outlook|Connect securely/i }),
  ).toHaveCount(0);

  await emailField.fill("sam@icloud-custom.example");
  await dialog.getByRole("button", { name: "Find settings" }).click();
  await expect(
    dialog.getByText(/This custom domain uses iCloud\+/),
  ).toBeVisible();
  if (!(await imapServer.isVisible())) {
    await dialog.getByText("Review or edit server settings").click();
  }
  await expect(imapServer).toHaveValue("imap.mail.me.com");
  await expect(
    dialog.getByRole("group", { name: "Incoming IMAP" }).getByLabel("Username"),
  ).toHaveValue("");

  await emailField.fill("sam@fastmail-custom.example");
  await dialog.getByRole("button", { name: "Find settings" }).click();
  await expect(
    dialog.getByText(/This custom domain uses Fastmail/),
  ).toBeVisible();
});

test("B9 Settings accounts re-auth recovery clears auth error", async ({
  page,
}) => {
  await page.goto("/?authError=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Sign-in failed");
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();

  await page.getByLabel("Update password").fill("abcd-efgh-ijkl-mnop");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText(/Password updated/)).toBeVisible();
});

test("E1 active account re-selection preserves mailboxes, messages, and outbox", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&localMail=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Outbox/i })).toBeVisible();

  await page
    .getByRole("button", { name: /Account.*Sam|Sam.*icloud/i })
    .first()
    .click();
  await page.getByRole("menuitemradio", { name: /Sam/i }).click();

  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Inbox/i })).toBeVisible();
  await page.getByRole("button", { name: /Outbox/i }).click();
  await expect(page.getByText(/Could not confirm/i)).toBeVisible();
});

test("E2 composer keeps Send enabled while saving and closes Send menu on Escape", async ({
  page,
}) => {
  await page.goto("/?slowSave=1");
  await page.getByRole("button", { name: "Compose" }).click();
  const dialog = page.getByRole("dialog", { name: "New message" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("combobox", { name: "To" }).fill("pat@example.test");
  await dialog.getByLabel("Subject").fill("Slow autosave test");

  await page.keyboard.press("Control+s");
  const sendButton = dialog.getByRole("button", { name: "Send", exact: true });
  await expect(sendButton).toBeEnabled();

  await dialog.locator("button.send-chevron").click();
  await expect(page.locator(".send-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".send-menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test("E3 right-click triage under after2s acts without opening or marking read", async ({
  page,
}) => {
  await page.goto("/?markRead=after2s");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toBeVisible();

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark read", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);

  await row.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});

test("E4 pagination preserves >100 rows and Command Palette folder jump clears search", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as unknown as {
      summary: Record<string, unknown>;
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseList = mock.handlers.list_messages;
    mock.handlers.list_messages = (args) => {
      if (!location.search.includes("longWindow")) return baseList(args);
      const makeItem = (index: number) => ({
        ...mock.summary,
        id: 8000 + index,
        uid: 8000 + index,
        messageId: `<win-${index}@example.com>`,
        subject: `Windowed note ${index + 1}`,
        receivedAt: new Date(
          Date.parse("2026-08-01T12:00:00Z") - index * 60_000,
        ).toISOString(),
        isRead: true,
        threadRoot: null,
      });
      if (args.cursor) {
        return {
          items: [makeItem(100), makeItem(101)],
          nextCursor: null,
          hasMore: false,
        };
      }
      const limit = Number(args.limit ?? 100);
      const count = limit > 100 ? 102 : 100;
      return {
        items: Array.from({ length: count }, (_, index) => makeItem(index)),
        nextCursor:
          limit > 100
            ? null
            : { receivedAt: "2026-08-01T10:00:00Z", uid: 8099 },
        hasMore: limit <= 100,
      };
    };
  });

  await page.goto("/?longWindow=1");
  await expect(
    page.getByRole("button", { name: "Load older mail" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load older mail" }).click();
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "aria-setsize",
    "102",
  );

  await emitTauriEvent(page, "message-changed", {
    accountId: "account-1",
    messageId: null,
    kind: "flags",
  });
  await expect
    .poll(async () => {
      const listCalls = (await ipcCalls(page)).filter(
        (call) => call.command === "list_messages",
      );
      return listCalls.some(
        (call) => Number((call.args as { limit?: number }).limit ?? 0) > 100,
      );
    })
    .toBe(true);
  await expect(page.getByRole("option").first()).toHaveAttribute(
    "aria-setsize",
    "102",
  );

  const searchInput = page.getByRole("searchbox");
  await searchInput.fill("Windowed");
  await searchInput.press("Enter");
  await expect(searchInput).toHaveValue("Windowed");
  await page.getByRole("option").first().focus();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: /Command palette/i });
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox", { name: /Search commands/ })
    .fill("Drafts");
  await palette
    .getByRole("option", { name: /Drafts/i })
    .first()
    .click();
  await expect(searchInput).toHaveValue("");
});

test("E5 editable filter rules, EmlViewer flex height + Cc, and PDF zoom", async ({
  page,
}) => {
  await page.goto("/?legacyRule=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  await page.getByRole("button", { name: "Rules", exact: true }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByLabel(/Rule name/i).fill("Edited rule 054");
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(page.getByText("Edited rule 054")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/?emlSeeded=1&emlCc=1&emlHtml=1");
  await expect(page.locator(".app-viewport")).toBeVisible();
  await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
  const viewer = page.locator(".eml-viewer");
  await expect(viewer).toBeVisible();
  const viewerBox = await viewer.boundingBox();
  expect(viewerBox?.height ?? 0).toBeGreaterThan(420);
  await expect(viewer.getByText("alex@example.test")).toBeVisible();

  await viewer
    .getByRole("button", { name: /Preview.*Lease\.pdf|Preview/i })
    .click();
  await expect(page.getByText(/3 pages/)).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("button", { name: "Reset zoom" })).toBeVisible();
  await expect(page.locator(".pdf-pages")).toHaveAttribute("data-zoom", "1.5");
});

test("E6 keyboard j/k, Mod+Alt+Arrow, Mica drawer opacity, and 3 densities + 200% scale", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/?rowMix=1");
  const rows = page.locator('[role="option"], [role="treeitem"]');
  await expect(rows.first()).toBeVisible();
  await rows.first().focus();
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("k");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  const openHeading = await page
    .locator("#reader-pane h1, #reader-pane h2")
    .first()
    .textContent();
  const frameBody = page.frameLocator(".message-body iframe").locator("body");
  if ((await page.locator(".message-body iframe").count()) > 0) {
    await frameBody.click();
    await page.keyboard.press("Shift+ArrowDown");
    await expect(
      page.locator("#reader-pane h1, #reader-pane h2").first(),
    ).toHaveText(openHeading ?? "");
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsDialog = page.getByRole("dialog", { name: /Settings/i });
  await expect(settingsDialog).toBeVisible();
  const settingsSearch = settingsDialog.getByRole("searchbox", {
    name: "Search settings",
  });
  await settingsSearch.fill("Notifications");
  await settingsSearch.press("Escape");
  await expect(settingsSearch).toHaveValue("");
  await expect(settingsDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settingsDialog).toHaveCount(0);

  await page.keyboard.press("Control+Alt+ArrowDown");
  await expect(page.locator("main.mail-shell")).toHaveClass(/pane-bottom/);

  await page.setViewportSize({ width: 820, height: 800 });
  await page.getByRole("button", { name: /Show mailboxes/i }).click();
  const folderAlpha = await page.evaluate(() => {
    const bg = getComputedStyle(
      document.querySelector(".folder-pane")!,
    ).backgroundColor;
    const match = bg.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
    return match ? Number(match[1]) : 1;
  });
  expect(folderAlpha).toBeGreaterThan(0.95);

  for (const combo of [
    { density: "normal", scale: 1 },
    { density: "comfortable", scale: 2 },
    { density: "compact", scale: 2 },
  ]) {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`/?density=${combo.density}&scale=${combo.scale}`);
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: /Command palette/i });
    await expect(palette).toBeVisible();
    const rect = await palette.boundingBox();
    expect(rect).toBeTruthy();
    expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(805);
    expect(rect?.height ?? 0).toBeGreaterThan(150);
    await page.keyboard.press("Escape");
  }
});
