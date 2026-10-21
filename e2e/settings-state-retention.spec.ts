import type { Dialog, Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

async function dismissConfirmFor(page: Page, action: () => Promise<void>) {
  const dialogType = page.waitForEvent("dialog").then(async (dialog) => {
    const type = dialog.type();
    await dialog.dismiss();
    return type;
  });
  await action();
  expect(await dialogType).toBe("confirm");
}

async function acceptConfirmFor(page: Page, action: () => Promise<void>) {
  const dialogType = page.waitForEvent("dialog").then(async (dialog) => {
    const type = dialog.type();
    await dialog.accept();
    return type;
  });
  await action();
  expect(await dialogType).toBe("confirm");
}

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md):
// 1. Tab-owned account, alias, or rule drafts disappear when Settings remounts a tab.
// 2. The rich signature HTML draft is omitted from close or tab-change guards.
// 3. Canceling a dirty-state guard discards edits or leaves the dialog closed.
// 4. Confirmed discard leaves name/reply/signature drafts dirty after returning.

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  if (!page.isClosed() && page.url() !== "about:blank") {
    await attachArtifacts(
      page,
      testInfo,
      `settings-retention-${testInfo.testId}`,
    );
  }
});

test("retains alias and filter-rule drafts while Settings sections change", async ({
  page,
}) => {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();

  const aliasInput = page.getByLabel("alias@yourdomain.com");
  await aliasInput.fill("kept-draft@example.test");
  await page.getByRole("tab", { name: "General" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await expect(page.getByLabel("alias@yourdomain.com")).toHaveValue(
    "kept-draft@example.test",
  );

  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await page.getByLabel("Rule name").fill("Keep this rule draft");
  await page.getByLabel("Text to match").fill("invoice@example.test");

  await dismissConfirmFor(page, () =>
    page.getByRole("tab", { name: "General" }).click(),
  );

  await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("Rule name")).toHaveValue(
    "Keep this rule draft",
  );
  await expect(page.getByLabel("Text to match")).toHaveValue(
    "invoice@example.test",
  );
});

test("rich signature HTML and account identity survive canceled Settings guards", async ({
  page,
}) => {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();

  const nameInput = page.getByLabel("Name on mail you send");
  await nameInput.fill("A retained account name");
  const editor = page.getByRole("textbox", { name: "Rich signature" });
  await editor.fill("Retained rich signature");
  await editor.evaluate((root) => {
    const node = root.querySelector("p")?.firstChild;
    if (!(node instanceof Text)) throw new Error("Expected signature text");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 8);
    const selection = window.getSelection();
    if (!selection) throw new Error("Selection API unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole("button", { name: "Bold" }).click();

  await dismissConfirmFor(page, () =>
    page.getByRole("tab", { name: "General" }).click(),
  );

  await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(nameInput).toHaveValue("A retained account name");
  await expect(editor.locator("strong")).toHaveText("Retained");

  await dismissConfirmFor(page, () =>
    page.getByRole("button", { name: "Close settings" }).click(),
  );

  await expect(page.locator(".settings-window")).toBeVisible();
  await expect(nameInput).toHaveValue("A retained account name");
  await expect(editor.locator("strong")).toHaveText("Retained");
});

test("confirmed discard clears account drafts and does not prompt again", async ({
  page,
}) => {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();

  const nameInput = page.getByLabel("Name on mail you send");
  const replyToInput = page.getByLabel("Reply-To address");
  const aliasInput = page.getByLabel("alias@yourdomain.com");
  const plainSignature = page.getByLabel("Email signature");
  const richSignature = page.getByRole("textbox", { name: "Rich signature" });
  const originalName = await nameInput.inputValue();
  const originalReplyTo = await replyToInput.inputValue();
  const originalPlainSignature = await plainSignature.inputValue();
  const originalRichSignature = await richSignature.innerHTML();

  await nameInput.fill("Discard this account name");
  await replyToInput.fill("discard-reply@example.test");
  await aliasInput.fill("discard-alias@example.test");
  await richSignature.fill("Discard this rich signature");
  await richSignature.evaluate((root) => {
    const node = root.querySelector("p")?.firstChild;
    if (!(node instanceof Text)) throw new Error("Expected signature text");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 7);
    const selection = window.getSelection();
    if (!selection) throw new Error("Selection API unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(plainSignature).toHaveValue("Discard this rich signature");
  await plainSignature.fill("Discard this plain signature");

  await dismissConfirmFor(page, () =>
    page.getByRole("tab", { name: "General" }).click(),
  );
  await expect(nameInput).toHaveValue("Discard this account name");
  await expect(replyToInput).toHaveValue("discard-reply@example.test");
  await expect(aliasInput).toHaveValue("discard-alias@example.test");
  await expect(plainSignature).toHaveValue("Discard this plain signature");
  await expect(richSignature.locator("strong")).toHaveText("Discard");

  await acceptConfirmFor(page, () =>
    page.getByRole("tab", { name: "General" }).click(),
  );
  await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  let unexpectedConfirms = 0;
  const acceptUnexpectedConfirm = async (dialog: Dialog) => {
    unexpectedConfirms += 1;
    await dialog.accept();
  };
  page.on("dialog", acceptUnexpectedConfirm);
  await page.getByRole("tab", { name: "Accounts" }).click();
  expect(unexpectedConfirms).toBe(0);
  await page.getByRole("button", { name: "Identity", exact: true }).click();

  await expect(nameInput).toHaveValue(originalName);
  await expect(replyToInput).toHaveValue(originalReplyTo);
  await expect(aliasInput).toHaveValue("");
  await expect(plainSignature).toHaveValue(originalPlainSignature);
  expect(await richSignature.innerHTML()).toBe(originalRichSignature);

  await page.getByRole("tab", { name: "General" }).click();
  await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator(".settings-window")).toHaveCount(0);
  expect(unexpectedConfirms).toBe(0);
  page.off("dialog", acceptUnexpectedConfirm);
});
