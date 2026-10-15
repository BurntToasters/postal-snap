import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A refused composer replacement (save fails) loses the typed note.
// 2. The refusal gives no visible reason.
// 3. A successful replacement leaves the note behind, or a later clear
//    removes a note typed afterwards.
// Each test ends with an IPC log and a screenshot.

const replaceSaveFailed =
  "Could not save the open message, so the new message was not opened.";

async function dirtyMinimizedDraft(page: Page) {
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("UNSAVED ORIGINAL");
  await page.getByRole("button", { name: "Minimize draft" }).click();
}

async function openWeekend(page: Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
}

test("a refused replacement keeps the note in the box", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    mock.handlers.save_draft = () => {
      throw new Error("Draft storage unavailable");
    };
  });
  await page.goto("/");
  await dirtyMinimizedDraft(page);
  await openWeekend(page);
  const box = page.getByRole("textbox", { name: "Write a reply" });
  await box.fill("See you then");
  // The docked draft pill covers the button, so press it by keyboard.
  await page
    .getByRole("button", { name: "Start reply", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: replaceSaveFailed }),
  ).toBeVisible();
  await expect(box).toHaveValue("See you then");
  await page.screenshot({ path: testInfo.outputPath("refused.png") });
  await attachIpcLog(page, testInfo);
});

test("a refused Ctrl+Enter keeps the note too", async ({ page }, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    mock.handlers.save_draft = () => {
      throw new Error("Draft storage unavailable");
    };
  });
  await page.goto("/");
  await dirtyMinimizedDraft(page);
  await openWeekend(page);
  const box = page.getByRole("textbox", { name: "Write a reply" });
  await box.fill("Still here");
  await box.press("Control+Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: replaceSaveFailed }),
  ).toBeVisible();
  await expect(box).toHaveValue("Still here");
  await attachIpcLog(page, testInfo);
});

test("an accepted replacement clears the note and a new note stays", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(
    browserName === "webkit",
    "Reply composer does not mount in headless WebKit",
  );
  await installMockIpc(page);
  await recordIpc(page);
  await page.goto("/");
  await dirtyMinimizedDraft(page);
  await openWeekend(page);
  const box = page.getByRole("textbox", { name: "Write a reply" });
  await box.fill("First note");
  // The docked draft pill covers the button, so press it by keyboard.
  await page
    .getByRole("button", { name: "Start reply", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue(/Weekend plans/);
  await expect(box).toHaveValue("");
  await box.fill("Second note");
  await page.waitForTimeout(300);
  await expect(box).toHaveValue("Second note");
  await attachIpcLog(page, testInfo);
});
