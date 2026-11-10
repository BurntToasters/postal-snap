import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import type { MockShared } from "./mock/context";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, emitTauriEvent, ipcCalls, ipcCommands } from "./ipc";

// Failure modes covered here:
// 1. A native frame-link click in an opened .eml does nothing on the setup screen (no reader mounted).
// 2. A frame-link click with a reader mounted checks link text against the reader's frame, not the viewer's.
// 3. A mailto link in an opened .eml is a silent no-op, with or without an account.
// Each run leaves a screenshot and IPC log under artifacts/0.5.2/eml-viewer-frame-link/.

const FILE_LINK = "https://files.example.test/lease";
const SIGN_TEXT = "https://sign.example.test/lease";
const MAILTO = "mailto:riley@example.test";
const SANDBOX = "allow-same-origin allow-popups";

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Lease renewal" });
}

// Swaps the opened message's fields in the mock, keeping the rest of the fixture.
async function setOpenedMessage(page: Page, fields: Record<string, unknown>) {
  await page.evaluate((patch) => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const original = mock.handlers.get_opened_message;
    if (!original) throw new Error("get_opened_message handler missing");
    mock.handlers.get_opened_message = (args) => {
      const opened = original(args) as {
        token: string;
        message: Record<string, unknown>;
      };
      return { ...opened, message: { ...opened.message, ...patch } };
    };
  }, fields);
}

async function openViewer(page: Page, fields: Record<string, unknown>) {
  await setOpenedMessage(page, fields);
  await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
  await expect(dialog(page)).toBeVisible();
}

async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.openedUrls ?? []);
}

test.beforeEach(async ({ page }) => installMockIpc(page));

test("a frame link in an opened file on the setup screen reaches link confirmation", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?noAccounts=1&emlSeeded=1");
  await expect(page.locator(".setup-host")).toBeVisible();
  await openViewer(page, {
    htmlBody: `<p>Sign here: <a href="${FILE_LINK}">${FILE_LINK}</a></p>`,
  });
  await expect(dialog(page).locator("iframe")).toHaveAttribute(
    "sandbox",
    SANDBOX,
  );

  page.once("dialog", async (native) => {
    expect(native.message()).toContain("files.example.test");
    await native.accept();
  });
  await emitTauriEvent(page, "frame-link", FILE_LINK);

  await expect.poll(() => ipcCommands(page)).toContain("inspect_external_url");
  const inspect = (await ipcCalls(page)).filter(
    (call) => call.command === "inspect_external_url",
  );
  expect(inspect.at(-1)?.args).toEqual({ url: FILE_LINK });
  await expect.poll(() => openedUrls(page)).toEqual([FILE_LINK]);
  await attachArtifacts(page, testInfo, "setup-screen-frame-link");
});

test("a mailto link in an opened file with no account says so and opens nothing", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?noAccounts=1&emlSeeded=1");
  await expect(page.locator(".setup-host")).toBeVisible();
  await openViewer(page, {
    htmlBody: `<p><a href="${MAILTO}">Email Riley</a></p>`,
  });

  await emitTauriEvent(page, "frame-link", MAILTO);

  await expect(dialog(page).locator(".eml-viewer-notice")).toHaveText(
    "Add a mail account to write to this address.",
  );
  await expect(page.locator(".composer-layer")).toHaveCount(0);
  expect(await ipcCommands(page)).not.toContain("inspect_external_url");
  await attachArtifacts(page, testInfo, "setup-screen-mailto-notice");
});

test("a plain-text mailto in an opened file opens the composer with the address", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?emlSeeded=1");
  await openViewer(page, {
    htmlBody: null,
    textBody: `Questions? Write to ${MAILTO} before Friday.`,
  });

  await dialog(page).getByRole("link", { name: "riley@example.test" }).click();

  const to = page
    .locator(".composer-layer")
    .getByRole("combobox", { name: "To", exact: true });
  await expect(to).toHaveValue(/riley@example\.test/);
  await attachArtifacts(page, testInfo, "plain-text-mailto-composer");
});

test("with a reader mounted, the mismatch warning names the viewer's link text", async ({
  page,
}, testInfo: TestInfo) => {
  // The reader's own frame has a link to bank.example with a different href;
  // the viewer's link must be judged against its own frame, not that one.
  await page.goto("/?mismatchLink=1&emlSeeded=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page
      .frameLocator('iframe[title="Message content"]')
      .getByRole("link", { name: "https://bank.example/login" }),
  ).toBeVisible();

  await openViewer(page, {
    htmlBody: `<p>Sign here: <a href="${FILE_LINK}">${SIGN_TEXT}</a></p>`,
  });

  page.once("dialog", async (native) => {
    const text = native.message();
    expect(text).toContain("files.example.test");
    expect(text).toContain(
      `The link text shows a different address: ${SIGN_TEXT}`,
    );
    expect(text).not.toContain("bank.example");
    await native.accept();
  });
  await emitTauriEvent(page, "frame-link", FILE_LINK);

  await expect.poll(() => openedUrls(page)).toEqual([FILE_LINK]);
  await attachArtifacts(page, testInfo, "reader-mounted-viewer-link-text");
});
