import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Switching to plain text silently drops formatting, with no confirmation.
// 2. The confirmation focuses the destructive choice first.
// 3. Plain drafts are saved or sent as HTML (htmlBody not empty).
// 4. Text typed in plain mode is lost or unescaped when switching back.
// 5. The plain editor ignores text scale or shows no focus ring.
// 6. The header menu cannot be used by keyboard, or Escape closes the composer.
// 7. The account default is not saved, or new messages ignore it.
// 8. A saved plain draft reopens as rich text.
// 9. Quoted reply text becomes unmarked when a reply starts as plain text.
// 10. Quoted lines in plain text trip the forgotten-attachment warning.
// The run ends with a screenshot and the recorded IPC calls.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

const plainBox = (page: Page) =>
  page.getByRole("textbox", { name: "Message body (plain text)" });

async function openMenu(page: Page) {
  await page.getByRole("button", { name: "Message options" }).click();
}

async function callsOf(page: Page, command: string) {
  return (await recordedCalls(page)).filter((call) => call.command === command);
}

test("confirms, converts, and sends a plain text message", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Plain hello");
  await page.getByLabel("Message body").pressSequentially("Hello there");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line");

  await openMenu(page);
  await expect(
    page.getByRole("menuitem", { name: "Plain text" }),
  ).toBeFocused();
  await page.getByRole("menuitem", { name: "Plain text" }).click();

  const confirm = page.getByRole("alertdialog", {
    name: "Switch to plain text?",
  });
  await expect(confirm).toContainText("Fonts, colors, links");
  await expect(
    confirm.getByRole("button", { name: "Keep rich text" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "Keep rich text" }).click();
  await expect(plainBox(page)).toHaveCount(0);

  await openMenu(page);
  await page.getByRole("menuitem", { name: "Plain text" }).click();
  await confirm.getByRole("button", { name: "Switch to plain text" }).click();

  await expect(plainBox(page)).toBeFocused();
  await expect(plainBox(page)).toHaveValue("Hello there\nSecond line");
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(
    0,
  );
  await plainBox(page).evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await plainBox(page).pressSequentially(" and more");

  await page.keyboard.press("Meta+s");
  await expect
    .poll(async () => (await callsOf(page, "save_draft")).length)
    .toBeGreaterThan(0);
  const saved = (await callsOf(page, "save_draft")).at(-1)?.args as {
    draft: { bodyFormat: string; htmlBody: string; textBody: string };
  };
  expect(saved.draft).toMatchObject({
    bodyFormat: "plain",
    htmlBody: "",
    textBody: "Hello there\nSecond line and more",
  });

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const [sent] = await callsOf(page, "send_message");
  expect(sent.args).toMatchObject({
    draft: {
      bodyFormat: "plain",
      htmlBody: "",
      textBody: "Hello there\nSecond line and more",
    },
  });

  await page.screenshot({ path: "test-results/compose-plaintext.png" });
  await testInfo.attach("final.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await attachIpcLog(page, testInfo);
});

test("switching back escapes text into paragraphs", async ({ page }) => {
  await page.goto("/?defaultPlain=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await plainBox(page).fill("<b>bold?</b> & more\n\nSecond paragraph");
  await openMenu(page);
  await page.getByRole("menuitem", { name: "Rich text" }).click();
  await expect(plainBox(page)).toHaveCount(0);
  const editor = page.locator(".composer-editor");
  await expect(editor.locator("p")).toHaveCount(2);
  await expect(editor.locator("b, strong")).toHaveCount(0);
  await expect(editor).toContainText("<b>bold?</b> & more");
});

test("header menu is keyboard operable and Escape keeps the composer", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const button = page.getByRole("button", { name: "Message options" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menu", { name: "Message options" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(page.locator(".composer-window")).toBeVisible();
  await page.keyboard.press("Enter");
  // Empty body: no formatting to lose, so the switch is immediate.
  await page.keyboard.press("Enter");
  await expect(plainBox(page)).toBeFocused();
  const target = await button.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(44);
  expect(target?.height).toBeGreaterThanOrEqual(44);
});

test("plain editor follows text scale and shows focus", async ({ page }) => {
  await page.goto("/?scale=2&defaultPlain=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await plainBox(page).focus();
  const metrics = await plainBox(page).evaluate((element) => {
    const style = getComputedStyle(element);
    const window = element.closest(".composer-window") as HTMLElement;
    return {
      fontSize: Number.parseFloat(style.fontSize),
      height: element.getBoundingClientRect().height,
      focusRing: style.boxShadow,
      clipped: window.scrollWidth > window.clientWidth,
    };
  });
  const rootSize = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(metrics.fontSize).toBeGreaterThanOrEqual(rootSize);
  expect(metrics.height).toBeGreaterThanOrEqual(160);
  expect(metrics.focusRing).not.toBe("none");
  expect(metrics.clipped).toBe(false);
});

test("account default starts new messages and replies as plain text", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page
    .getByLabel("New messages start as")
    .selectOption({ label: "Plain text" });
  await expect(page.getByText("New message format saved.")).toBeVisible();
  const [update] = await callsOf(page, "update_account_default_body_format");
  expect(update.args).toEqual({
    accountId: expect.any(String),
    format: "plain",
  });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(plainBox(page)).toBeVisible();
  await page.getByRole("button", { name: "Save draft and close" }).click();

  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(plainBox(page)).toBeVisible();
  await expect(plainBox(page)).toHaveValue(
    /> Are we still meeting on Saturday\?/,
  );
  await testInfo.attach("reply.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("a saved plain draft reopens as plain text", async ({ page }) => {
  await page.goto("/?localMail=1&plainDraft=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: /Family update/i }).click();
  await expect(plainBox(page)).toHaveValue("Plain draft line\n> quoted line");
});

test("quoted plain lines do not trigger the attachment warning", async ({
  page,
}) => {
  await page.goto("/?defaultPlain=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await plainBox(page).fill(
    "Sounds good\n> you attached the file?\n\n-- \nattached sig",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await expect(
    page.getByRole("alertdialog", { name: "Send without an attachment?" }),
  ).toHaveCount(0);
  expect(await callsOf(page, "send_message")).toHaveLength(1);
});
