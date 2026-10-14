import { expect, test } from "./coverage-fixture";
import {
  attachIpcLog,
  emitTauriEvent,
  recordIpc,
  recordedCalls,
} from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Quit while writing exits before the latest edits are saved.
// 2. The save happens after quit_app, so the process exit cuts it off.
// 3. Native Quit is not told a message is open, so it exits directly.
// 4. A stuck or failed save exits and loses unsaved edits.
// 5. Quit with no message open writes an empty draft.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

const commandsOf = async (page: import("@playwright/test").Page) =>
  (await recordedCalls(page)).map((call) => call.command);

test("quit saves the open message before exiting", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Quit check");
  await expect
    .poll(async () =>
      (await recordedCalls(page)).some(
        (call) =>
          call.command === "set_composer_open" &&
          (call.args as { open: boolean }).open,
      ),
    )
    .toBe(true);
  expect(await commandsOf(page)).not.toContain("save_draft");

  await emitTauriEvent(page, "tray-quit", null);

  await expect.poll(() => commandsOf(page)).toContain("quit_app");
  const calls = await recordedCalls(page);
  const saveAt = calls.findIndex((call) => call.command === "save_draft");
  const quitAt = calls.findIndex((call) => call.command === "quit_app");
  expect(saveAt).toBeGreaterThanOrEqual(0);
  expect(saveAt).toBeLessThan(quitAt);
  expect(
    (calls[saveAt].args as { draft: { subject: string } }).draft.subject,
  ).toBe("Quit check");
  await attachIpcLog(page, testInfo);
});

test("quit stays open when the save never finishes", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const mock = (
      window as unknown as {
        __POSTAL_SNAP_MOCK__: {
          handlers: Record<string, (args: unknown) => unknown>;
        };
      }
    ).__POSTAL_SNAP_MOCK__;
    mock.handlers.save_draft = () => new Promise(() => undefined);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("textbox", { name: "Subject" }).fill("Stuck save");

  await emitTauriEvent(page, "tray-quit", null);

  await expect(
    page.getByText(
      "Your draft could not be saved. Try quitting again after saving the message.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 10_000 });
  expect(await commandsOf(page)).not.toContain("quit_app");
  expect(await commandsOf(page)).toContain("save_draft");
  await attachIpcLog(page, testInfo);
});

test("quit with no open message does not write a draft", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Compose", exact: true }),
  ).toBeVisible();

  await emitTauriEvent(page, "tray-quit", null);

  await expect.poll(() => commandsOf(page)).toContain("quit_app");
  expect(await commandsOf(page)).not.toContain("save_draft");
  await attachIpcLog(page, testInfo);
});

test("failed draft save prevents quitting", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    mock.handlers.save_draft = () => {
      throw new Error("Draft storage unavailable");
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("textbox", { name: "Subject" }).fill("Keep this draft");
  await emitTauriEvent(page, "tray-quit", null);
  await expect(
    page.getByText(
      "Your draft could not be saved. Try quitting again after saving the message.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await commandsOf(page)).not.toContain("quit_app");
  await expect(page.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "Keep this draft",
  );
  await attachIpcLog(page, testInfo);
});

// Edits during the final save must be persisted before exit. Repeated Quit
// events must share one flush instead of creating duplicate drafts.
test("quit saves edits made during an in-flight save once", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    const save = mock.handlers.save_draft;
    const quit = mock.handlers.quit_app;
    let savedSubject = "";
    mock.handlers.save_draft = async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const outcome = await save(args);
      savedSubject = (args.draft as { subject: string }).subject;
      return outcome;
    };
    mock.handlers.quit_app = (args) => {
      localStorage.setItem("subject-at-quit", savedSubject);
      return quit(args);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const subject = page.getByRole("textbox", { name: "Subject" });
  await subject.fill("First revision");
  await emitTauriEvent(page, "tray-quit", null);
  await expect.poll(() => commandsOf(page)).toContain("save_draft");
  await subject.fill("Latest revision");
  await emitTauriEvent(page, "tray-quit", null);
  await expect.poll(() => commandsOf(page)).toContain("quit_app");
  expect(
    await page.evaluate(() => localStorage.getItem("subject-at-quit")),
  ).toBe("Latest revision");
  const calls = await recordedCalls(page);
  const saves = calls.filter((call) => call.command === "save_draft");
  expect(
    (saves.at(-1)?.args as { draft: { subject: string } }).draft.subject,
  ).toBe("Latest revision");
  expect(calls.filter((call) => call.command === "quit_app")).toHaveLength(1);
  await attachIpcLog(page, testInfo);
});
