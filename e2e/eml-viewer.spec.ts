import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, emitTauriEvent, ipcCalls, ipcCommands } from "./ipc";
import { pressAppShortcut } from "./keyboard";

// Failure modes covered here (WP5.13):
// 1. The eml-opened event does not show the viewer, or shows it without the subject.
// 2. The body iframe lacks the exact sandbox, or grants allow-scripts.
// 3. A script in the message body runs.
// 4. A remote image loads, offers a load button, or makes a network or proxy call.
// 5. Focus escapes the viewer, Escape does not close it, or focus does not return to the opener.
// 6. Saving an attachment sends anything besides the token and attachment id.
// 7. A nested message/rfc822 in an opened file offers View (no backend), or a reader View misses its real ids.
// 8. The "Open email file" palette command does not reach the file flow, or a cancel shows a viewer.
// 9. A bounded OS-open burst can acknowledge a failed token and still open the next valid file.

type MockWindow = Window & { __pwned?: unknown };

const SUBJECT = "Lease renewal";
const SANDBOX = "allow-same-origin allow-popups";

function dialog(page: Page, name: string = SUBJECT) {
  return page.getByRole("dialog", { name });
}

async function openSeeded(page: Page, query = "") {
  await page.goto(`/?emlSeeded=1${query ? `&${query}` : ""}`);
  await expect(page.locator(".app-viewport")).toBeVisible();
  await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
  await expect(dialog(page)).toBeVisible();
}

test.describe("eml viewer", () => {
  test.beforeEach(async ({ page }) => installMockIpc(page));

  test("eml-opened event shows the viewer with the subject", async ({
    page,
  }, testInfo: TestInfo) => {
    await openSeeded(page);
    await expect(
      dialog(page).getByRole("heading", { name: SUBJECT }),
    ).toBeVisible();
    await expect(
      dialog(page).getByText("Opened from a file. It is not in your mailbox."),
    ).toBeVisible();
    await attachArtifacts(page, testInfo, "eml-viewer-open");
  });

  test("cold startup drains a native OS-open token before it is evicted", async ({
    page,
  }) => {
    await page.goto("/?emlColdOpen=1");
    await expect(dialog(page, "Cold launch message")).toBeVisible();
    const calls = await ipcCalls(page);
    expect(
      calls.filter((call) => call.command === "drain_opened_message_tokens"),
    ).toHaveLength(1);
    expect(
      calls
        .filter((call) => call.command === "get_opened_message")
        .map((call) => call.args),
    ).toEqual([{ token: "opened-eml-cold" }]);
    expect(
      calls
        .filter((call) => call.command === "acknowledge_opened_message_token")
        .map((call) => call.args),
    ).toEqual([{ token: "opened-eml-cold" }]);
    expect(JSON.stringify(calls)).not.toMatch(/file:|\/tmp\/|private-folder/);
  });

  test("a bounded OS-open burst redacts a read failure, acknowledges it, and opens the next file", async ({
    page,
  }) => {
    const tokens = [
      "missing-eml-0",
      "missing-eml-1",
      "missing-eml-2",
      "missing-eml-3",
      "missing-eml-4",
      "missing-eml-5",
      "missing-eml-6",
      "opened-eml-1",
    ];
    await page.goto("/?emlSeeded=1");
    await expect(page.locator(".app-viewport")).toBeVisible();
    await expect
      .poll(() => ipcCommands(page))
      .toContain("drain_opened_message_tokens");

    for (const token of tokens)
      await emitTauriEvent(page, "eml-opened", { token });

    await expect(dialog(page)).toContainText(SUBJECT);
    await expect
      .poll(
        async () =>
          (await ipcCalls(page)).filter(
            (call) => call.command === "acknowledge_opened_message_token",
          ).length,
      )
      .toBe(tokens.length);

    const calls = await ipcCalls(page);
    const tokensFor = (command: string) =>
      calls
        .filter((call) => call.command === command)
        .map((call) => {
          const args = call.args;
          if (
            !args ||
            typeof args !== "object" ||
            !("token" in args) ||
            typeof args.token !== "string"
          ) {
            throw new Error(`${command} did not include an opaque token.`);
          }
          return args.token;
        });
    expect(tokensFor("get_opened_message")).toEqual(tokens);
    expect(tokensFor("acknowledge_opened_message_token")).toEqual(tokens);
    expect(page.locator(".error-toast")).toHaveCount(1);
    await expect(page.locator(".error-toast")).toContainText(
      "That item is no longer available. Refresh mail and try again.",
    );
    await expect(page.locator(".error-toast")).not.toContainText(
      /missing-eml|\/Users\/|@example/,
    );
  });

  test("deduplicates the startup race and opens multiple OS files in order", async ({
    page,
  }) => {
    await page.goto("/?emlHandoffOrder=1");
    await expect(dialog(page, "Second open")).toBeVisible();
    const orderedReads = () =>
      ipcCalls(page).then((calls) =>
        calls
          .filter((call) => call.command === "get_opened_message")
          .map((call) => {
            const args = call.args;
            if (
              !args ||
              typeof args !== "object" ||
              !("token" in args) ||
              typeof args.token !== "string"
            ) {
              throw new Error("Opened-message call did not include a token.");
            }
            return args.token;
          }),
      );
    await expect
      .poll(orderedReads)
      .toEqual(["opened-eml-slow", "opened-eml-fast"]);
    expect(
      (await ipcCalls(page)).filter(
        (call) => call.command === "close_opened_message",
      ),
    ).toContainEqual({
      command: "close_opened_message",
      args: { token: "opened-eml-slow" },
    });

    await emitTauriEvent(page, "eml-opened", { token: "opened-eml-fast" });
    await page.waitForTimeout(50);
    expect(await orderedReads()).toEqual([
      "opened-eml-slow",
      "opened-eml-fast",
    ]);
    await page.keyboard.press("Escape");
    await expect(dialog(page, "Second open")).toHaveCount(0);
    await emitTauriEvent(page, "eml-opened", { token: "opened-eml-fast" });
    await page.waitForTimeout(50);
    await expect(dialog(page, "Second open")).toHaveCount(0);
    expect(await orderedReads()).toHaveLength(2);
  });

  test("a webview unmount during startup drain leaves the native token recoverable", async ({
    page,
  }) => {
    await page.goto("/?emlColdOpen=1&emlSlowDrain=1");
    await expect
      .poll(
        async () =>
          (await ipcCommands(page)).filter(
            (command) => command === "drain_opened_message_tokens",
          ).length,
      )
      .toBe(1);
    await page.reload();
    await expect(dialog(page, "Cold launch message")).toBeVisible();
    const calls = await ipcCalls(page);
    expect(
      calls.filter((call) => call.command === "get_opened_message"),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call.command === "acknowledge_opened_message_token",
      ),
    ).toHaveLength(1);
  });

  test("body iframe uses the exact sandbox and no allow-scripts", async ({
    page,
  }, testInfo: TestInfo) => {
    await openSeeded(page, "emlHtml=1");
    const frame = dialog(page).locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", SANDBOX);
    const sandbox = (await frame.getAttribute("sandbox")) ?? "";
    expect(sandbox.split(/\s+/)).not.toContain("allow-scripts");
    await attachArtifacts(page, testInfo, "eml-viewer-sandbox");
  });

  test("a script in the message body never runs", async ({
    page,
  }, testInfo: TestInfo) => {
    await openSeeded(page, "emlHtml=1");
    await expect(
      page
        .frameLocator('iframe[title="Message content"]')
        .getByText("Here is the signed lease."),
    ).toBeVisible();
    const frameFlag = await dialog(page)
      .locator("iframe")
      .evaluate(
        (node) =>
          ((node as HTMLIFrameElement).contentWindow as MockWindow | null)
            ?.__pwned,
      );
    expect(frameFlag).toBeUndefined();
    expect(await page.evaluate(() => (window as MockWindow).__pwned)).toBe(
      undefined,
    );
    await attachArtifacts(page, testInfo, "eml-viewer-no-script");
  });

  test("remote images stay blocked with no load button or network call", async ({
    page,
  }, testInfo: TestInfo) => {
    const tracker: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("tracker.example.test"))
        tracker.push(request.url());
    });
    await openSeeded(page, "emlHtml=1");
    await expect(
      dialog(page).getByText("1 remote image blocked"),
    ).toBeVisible();
    await expect(
      dialog(page).getByRole("button", { name: /Load images|Retry loading/ }),
    ).toHaveCount(0);
    await expect(
      dialog(page)
        .locator("iframe")
        .contentFrame()
        .locator(".remote-image-blocked"),
    ).toHaveCount(1);
    expect(await ipcCommands(page)).not.toContain("fetch_remote_image");
    expect(tracker).toEqual([]);
    await attachArtifacts(page, testInfo, "eml-viewer-remote-images");
  });

  test("focus stays in the viewer, Escape closes it, focus returns to the opener", async ({
    page,
  }, testInfo: TestInfo) => {
    await page.goto("/?emlSeeded=1");
    await expect(page.locator(".app-viewport")).toBeVisible();
    await page.evaluate(() => {
      const opener = document.createElement("button");
      opener.id = "eml-opener";
      opener.textContent = "Opener";
      document.body.append(opener);
      opener.focus();
    });
    await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
    const viewer = dialog(page);
    await expect(viewer).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('[role="dialog"]')),
        ),
      )
      .toBe(true);
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[role="dialog"]')),
      );
      expect(inside).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(page.locator("#eml-opener")).toBeFocused();
    await expect
      .poll(() => ipcCommands(page))
      .toContain("close_opened_message");
    await attachArtifacts(page, testInfo, "eml-viewer-focus");
  });

  test("saving an attachment sends only the token and attachment id", async ({
    page,
  }, testInfo: TestInfo) => {
    await openSeeded(page);
    await dialog(page).getByRole("button", { name: "Save Lease.pdf" }).click();
    await expect
      .poll(() => ipcCommands(page))
      .toContain("save_opened_attachment");
    const calls = (await ipcCalls(page)).filter(
      (call) => call.command === "save_opened_attachment",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({
      token: "opened-eml-1",
      attachmentId: "pdf-1",
    });
    await attachArtifacts(page, testInfo, "eml-viewer-save");
  });

  test("a nested message/rfc822 in an opened file offers Save only", async ({
    page,
  }, testInfo: TestInfo) => {
    await openSeeded(page);
    const viewer = dialog(page);
    await expect(
      viewer.getByRole("button", { name: "Save Forwarded.eml" }),
    ).toBeVisible();
    await expect(
      viewer.getByRole("button", { name: "View Forwarded.eml" }),
    ).toHaveCount(0);
    expect(await ipcCommands(page)).not.toContain("view_attachment_message");
    await attachArtifacts(page, testInfo, "eml-viewer-nested-save-only");
  });

  test("reader View on a mailbox message/rfc822 passes its real ids and opens the viewer", async ({
    page,
  }, testInfo: TestInfo) => {
    await page.goto("/?rfcMessage=1");
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    await page.getByRole("button", { name: "View Forwarded.eml" }).click();
    await expect(dialog(page, "Forwarded note")).toBeVisible();
    const [view] = (await ipcCalls(page)).filter(
      (call) => call.command === "view_attachment_message",
    );
    const lastGet = (await ipcCalls(page))
      .filter((call) => call.command === "get_message")
      .at(-1);
    expect(view?.args).toEqual({
      accountId: "account-1",
      messageId: (lastGet?.args as { messageId: number }).messageId,
      attachmentId: "mail-rfc",
    });
    await attachArtifacts(page, testInfo, "eml-viewer-reader-view");
  });

  test("the palette command runs the file flow; a cancel shows nothing", async ({
    page,
  }, testInfo: TestInfo) => {
    await page.goto("/");
    await expect(page.locator(".app-viewport")).toBeVisible();
    await pressAppShortcut(page, "K");
    const combobox = page.getByRole("combobox", { name: /Search commands/ });
    await expect(combobox).toBeFocused();
    await combobox.fill("Open email file");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    expect(await ipcCommands(page)).toContain("open_eml_file");
    await attachArtifacts(page, testInfo, "eml-viewer-palette");
  });

  test("cancelling the file picker shows no viewer", async ({
    page,
  }, testInfo: TestInfo) => {
    await page.goto("/?emlCancel=1");
    await expect(page.locator(".app-viewport")).toBeVisible();
    await pressAppShortcut(page, "K");
    await page
      .getByRole("combobox", { name: /Search commands/ })
      .fill("Open email file");
    await page.keyboard.press("Enter");
    await expect.poll(() => ipcCommands(page)).toContain("open_eml_file");
    await expect(page.getByRole("dialog", { name: SUBJECT })).toHaveCount(0);
    await attachArtifacts(page, testInfo, "eml-viewer-cancel");
  });
});
