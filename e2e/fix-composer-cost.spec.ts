import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// FM1. Typing 50 characters into Subject or To runs the compose sanitizer at most once.
// FM2. Reply and forward seeds still render sanitized (script, on*, javascript: stripped).
// FM3. A pasted HTML clipboard is still sanitized before it reaches the editor.
// FM4. Typed body text is not reset while typing in Subject.
// Each run writes an IPC log and screenshot through attachArtifacts.

const HOSTILE =
  '<p onclick="window.__pwned = 1">Hostile line</p><script>window.__pwned = 2</script><a href="javascript:window.__pwned = 3">Bad link</a>';
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX";

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  // Every fetched message body carries hostile markup ahead of its own HTML.
  await page.addInitScript((html) => {
    const mock = window.__POSTAL_SNAP_MOCK__ as unknown as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const base = mock.handlers.get_message;
    mock.handlers.get_message = (args) => {
      const message = base(args) as Record<string, unknown>;
      if (typeof message.htmlBody !== "string") return message;
      return { ...message, htmlBody: html + message.htmlBody };
    };
  }, HOSTILE);
});

type PerfWindow = { __POSTAL_SNAP_PERF__?: { sanitize?: number } };

function sanitizeCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as PerfWindow).__POSTAL_SNAP_PERF__?.sanitize ?? 0,
  );
}

async function expectNoActiveMarkup(page: Page) {
  const editor = page.locator(".composer-editor");
  await expect(editor.locator("script")).toHaveCount(0);
  await expect(editor.locator("[onclick]")).toHaveCount(0);
  await expect(editor.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __pwned?: unknown }).__pwned ?? null,
    ),
    "no hostile script ran",
  ).toBeNull();
}

test("typing 50 characters into Subject or To sanitizes at most once", async ({
  page,
}, testInfo: TestInfo) => {
  // A reply seed carries quoted HTML, so the seed sanitizes on mount.
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("r");
  await expect(page.locator("#composer-subject")).toHaveValue(
    "Re: Weekend plans",
  );
  await expect(page.locator(".composer-editor")).toContainText("Hostile line");

  const before = await sanitizeCount(page);
  expect(before, "seed sanitizes on mount").toBeGreaterThan(0);
  await page.locator("#composer-subject").pressSequentially(LETTERS);
  const afterSubject = await sanitizeCount(page);
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .pressSequentially(LETTERS);
  const afterTo = await sanitizeCount(page);

  expect(afterSubject - before, "Subject typing").toBeLessThanOrEqual(1);
  expect(afterTo - afterSubject, "To typing").toBeLessThanOrEqual(1);
  await attachArtifacts(page, testInfo, "typing-sanitize", {
    subjectDelta: afterSubject - before,
    toDelta: afterTo - afterSubject,
  });
});

test("reply seed renders sanitized quoted HTML", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("r");
  await expect(page.locator("#composer-subject")).toHaveValue(
    "Re: Weekend plans",
  );
  await expect(page.locator(".composer-editor")).toContainText("Hostile line");
  await expectNoActiveMarkup(page);
  await attachArtifacts(page, testInfo, "reply-seed");
});

test("forward seed renders sanitized quoted HTML", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).focus();
  await page.keyboard.press("f");
  await expect(page.locator("#composer-subject")).toHaveValue(
    "Fwd: Weekend plans",
  );
  await expect(page.locator(".composer-editor")).toContainText("Hostile line");
  await expectNoActiveMarkup(page);
  await attachArtifacts(page, testInfo, "forward-seed");
});

test("pasted HTML is sanitized before it reaches the editor", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Message body" });
  await editor.click();
  await editor.evaluate((node, html) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/html", html);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboard });
    node.dispatchEvent(event);
  }, HOSTILE);
  await expect(page.locator(".composer-editor")).toContainText("Hostile line");
  await expectNoActiveMarkup(page);
  await attachArtifacts(page, testInfo, "paste-sanitized");
});

test("typing in Subject does not reset typed body text", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByRole("textbox", { name: "Message body" });
  await body.click();
  await body.pressSequentially("Keep this line");
  await page.locator("#composer-subject").click();
  await page.locator("#composer-subject").pressSequentially("Quarterly notes");
  await expect(body).toContainText("Keep this line");
  await expect(page.locator("#composer-subject")).toHaveValue(
    "Quarterly notes",
  );
  await attachArtifacts(page, testInfo, "body-kept");
});
