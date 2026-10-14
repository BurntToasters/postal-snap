import { expect, test } from "./coverage-fixture";
import {
  attachIpcLog,
  emitTauriEvent,
  recordIpc,
  recordedCalls,
} from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A mailto arrives while a dirty composer is open and its save fails.
//    The replacement must not open, or the only copy of the edits is lost.
// 2. The failed replacement must say the new message was not opened.
// 3. A successful save before replacement keeps the edits as a draft.

const originalSubject = "UNSAVED ORIGINAL CONTENT";
const mailto = "mailto:lee@example.test?subject=Replacement";

test("a failed save keeps the dirty composer open", async ({
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
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill(originalSubject);
  await emitTauriEvent(page, "deep-link://new-url", [mailto]);

  await expect(
    page.getByRole("alert").filter({
      hasText:
        "Could not save the open message, so the new message was not opened.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue(originalSubject);
  await attachIpcLog(page, testInfo);
});

test("a successful save keeps the edits and opens the replacement", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill(originalSubject);
  await emitTauriEvent(page, "deep-link://new-url", [mailto]);

  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue("Replacement");
  const saves = (await recordedCalls(page)).filter(
    (call) => call.command === "save_draft",
  );
  expect(
    saves.some(
      (call) =>
        (call.args as { draft: { subject: string } }).draft.subject ===
        originalSubject,
    ),
  ).toBe(true);
  await attachIpcLog(page, testInfo);
});
