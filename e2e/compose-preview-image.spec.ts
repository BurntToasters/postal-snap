import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";
import { receivesPointerHit } from "./pointer-hit";

// Failure modes covered here:
// 1. An attached picture can be previewed and stays attached after closing.
// 2. A file that is not a picture has no preview.
// 3. The preview owns focus: Tab, Shift+Tab, and Escape stay in it, the
//    composer behind is inert, and closing returns focus to Preview.
// Each test ends with a screenshot.

// Commands that would change the attachment list or the saved draft.
const DRAFT_WRITES = new Set([
  "save_draft",
  "send_message",
  "delete_draft",
  "release_compose_attachments",
]);

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/compose-preview-image-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an attached picture can be previewed", async ({ page }) => {
  await page.goto("/?pickImage=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await page.getByRole("button", { name: "Preview family-photo.jpg" }).click();
  const dialog = page.getByRole("dialog", { name: "family-photo.jpg" });
  await expect(
    dialog.getByRole("img", { name: "family-photo.jpg" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".compose-attachments")).toContainText(
    "family-photo.jpg",
  );
});

test("a file that is not a picture has no preview", async ({ page }) => {
  await page.goto("/?pickFile=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "budget.pdf",
  );
  await expect(page.getByRole("button", { name: /Preview / })).toHaveCount(0);
});

/** Attaches a picture to a saved draft and returns the state the preview must keep. */
async function savedPhotoDraft(page: Page) {
  await page.goto("/?pickImage=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("Photos");
  await page
    .getByRole("textbox", { name: "Message body" })
    .fill("Sunday photo");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "family-photo.jpg",
  );
  // Window blur autosaves, so the draft settles before the preview opens.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByText(/Draft saved/).first()).toBeVisible();
  return draftState(page);
}

/** Attachments, draft text, save status, and draft writes so far. */
async function draftState(page: Page) {
  const writes = (await recordedCalls(page)).filter((call) =>
    DRAFT_WRITES.has(call.command),
  ).length;
  return {
    attachments: await page.locator(".compose-attachments").innerText(),
    subject: await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .inputValue(),
    body: await page.getByRole("textbox", { name: "Message body" }).innerText(),
    saveStatus: await page
      .getByText(/Draft saved/)
      .first()
      .innerText(),
    writes,
  };
}

test("the preview owns Tab, Shift+Tab, and Escape, then returns focus to Preview", async ({
  page,
}) => {
  const before = await savedPhotoDraft(page);
  const trigger = page.getByRole("button", {
    name: "Preview family-photo.jpg",
  });
  await trigger.click();
  const preview = page.getByRole("dialog", { name: "family-photo.jpg" });
  const close = preview.getByRole("button", { name: "Close", exact: true });
  await expect(preview).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();

  // The composer behind is inert, so Save draft and close is out of the a11y tree.
  await expect(page.locator(".composer-layer")).toHaveAttribute("inert", "");
  const saveAndClose = page.locator(
    '.composer-layer button[aria-label="Save draft and close"]',
  );
  expect(
    await saveAndClose.evaluate((node) => node.closest("[inert]") !== null),
  ).toBe(true);

  // Escape closes only the preview: the draft stays open and unchanged.
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(page.locator(".composer-window")).toBeVisible();
  await expect(page.locator(".composer-layer")).not.toHaveAttribute("inert");
  await expect(trigger).toBeFocused();
  expect(await draftState(page)).toEqual(before);
});

test("Close returns focus to Preview without changing the draft", async ({
  page,
}) => {
  const before = await savedPhotoDraft(page);
  const trigger = page.getByRole("button", {
    name: "Preview family-photo.jpg",
  });
  await trigger.click();
  const preview = page.getByRole("dialog", { name: "family-photo.jpg" });
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await draftState(page)).toEqual(before);
});

// The preview is body-level now, so check its card and Close at 620x540 and 200%.
for (const density of ["comfortable", "compact"] as const) {
  test(`the picture preview fits a 620x540 window at 200%: ${density}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await page.goto(`/?pickImage=1&density=${density}&scale=2`);
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await page
      .getByRole("button", { name: "Preview family-photo.jpg" })
      .click();
    const preview = page.getByRole("dialog", { name: "family-photo.jpg" });
    const close = preview.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeFocused();

    const card = await preview.boundingBox();
    expect(card).not.toBeNull();
    expect(card!.x).toBeGreaterThanOrEqual(0);
    expect(card!.x + card!.width).toBeLessThanOrEqual(620);
    await close.scrollIntoViewIfNeeded();
    expect(await receivesPointerHit(close)).toBe(true);
    const previewShot = testInfo.outputPath("picture-preview-200.png");
    await page.screenshot({ path: previewShot });
    await testInfo.attach("picture-preview-200", {
      path: previewShot,
      contentType: "image/png",
    });
  });
}
