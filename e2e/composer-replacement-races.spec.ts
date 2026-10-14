import { expect, test } from "./coverage-fixture";
import {
  attachIpcLog,
  emitTauriEvent,
  recordIpc,
  recordedCalls,
} from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Ways a replacement (mailto, Reply, Forward, Compose) can lose or corrupt mail:
// 1. A replacement during an active Send unmounts the sending composer. If the
//    send then fails, the only copy of the message is gone.
// 2. A send that succeeds closes the composer by global state, so a stale
//    close can hide a newer composer.
// 3. Two replacements in flight both flush the old editor. The second then
//    replaces the first replacement without saving what the user typed into it.
// 4. A replacement waits on a save; the user discards meanwhile. The waiting
//    save must not write the discarded draft back.
// 5. A replacement waits on a save; the user sends meanwhile. The waiting save
//    must not run after the send, or it creates a ghost draft.
// 6. A save failure at any step must keep the current editor and show why.

const replaceSaveFailed =
  "Could not save the open message, so the new message was not opened.";
const replaceWhileSending =
  "A message is still sending, so the new message was not opened.";
const mailto = (name: string) => `mailto:${name}@example.test?subject=${name}`;

test("a replacement during an active send is refused and the composer survives a failed send", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    (window as unknown as { rejectSend: () => void }).rejectSend = () => {};
    mock.handlers.send_message = () =>
      new Promise((_, reject) => {
        (window as unknown as { rejectSend: () => void }).rejectSend = () =>
          reject(new Error("Sending could not start"));
      });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.test");
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("ORIGINAL UNSENT");
  await page
    .getByLabel("Message body")
    .pressSequentially("Original unsent body");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter((c) => c.command === "send_message")
          .length,
    )
    .toBe(1);

  await emitTauriEvent(page, "deep-link://new-url", [mailto("second")]);
  await expect(
    page.getByRole("alert").filter({ hasText: replaceWhileSending }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue("ORIGINAL UNSENT");

  await page.evaluate(() =>
    (window as unknown as { rejectSend: () => void }).rejectSend(),
  );
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue("ORIGINAL UNSENT");
  await expect(page.getByLabel("Message body")).toContainText(
    "Original unsent body",
  );
  await attachIpcLog(page, testInfo);
  await page.screenshot({ path: testInfo.outputPath("failed-send.png") });
});

test("a successful send closes its own composer and a refused replacement stays out", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const original = mock.handlers.send_message;
    const state = window as unknown as { finishSend: () => void };
    mock.handlers.send_message = (args: Record<string, unknown>) =>
      new Promise((resolve) => {
        state.finishSend = () => resolve(original(args));
      });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.test");
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("SENDING NOW");
  await page.getByLabel("Message body").pressSequentially("Sending body");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter((c) => c.command === "send_message")
          .length,
    )
    .toBe(1);

  await emitTauriEvent(page, "deep-link://new-url", [mailto("late")]);
  await expect(
    page.getByRole("alert").filter({ hasText: replaceWhileSending }),
  ).toBeVisible();

  await page.evaluate(() =>
    (window as unknown as { finishSend: () => void }).finishSend(),
  );
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveCount(0);
  await attachIpcLog(page, testInfo);
});

test("overlapping replacements save each editor before replacing it", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    let count = 0;
    const state = window as unknown as { releaseSave: Array<() => void> };
    state.releaseSave = [];
    mock.handlers.save_draft = () => {
      count++;
      if (count > 2)
        throw new Error("Storage unavailable for intermediate draft");
      return new Promise((resolve) => {
        state.releaseSave.push(() =>
          resolve({ id: "original-draft", syncState: "localPending" }),
        );
      });
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const subject = page.getByRole("textbox", { name: "Subject", exact: true });
  await subject.fill("ORIGINAL");
  const saves = async () =>
    (await recordedCalls(page)).filter((c) => c.command === "save_draft")
      .length;
  const release = (index: number) =>
    page.evaluate(
      (i) =>
        (window as unknown as { releaseSave: Array<() => void> }).releaseSave[
          i
        ](),
      index,
    );

  await emitTauriEvent(page, "deep-link://new-url", [mailto("first")]);
  await expect.poll(saves).toBe(1);
  await emitTauriEvent(page, "deep-link://new-url", [mailto("second")]);
  await release(0);
  await expect(subject).toHaveValue("first");
  await expect.poll(saves).toBe(2);

  await subject.fill("INTERMEDIATE UNSAVED CONTENT");
  await release(1);
  await expect(
    page.getByRole("alert").filter({ hasText: replaceSaveFailed }),
  ).toBeVisible();
  await expect(subject).toHaveValue("INTERMEDIATE UNSAVED CONTENT");
  await expect.poll(saves).toBeGreaterThan(2);
  await attachIpcLog(page, testInfo);
  await page.screenshot({
    path: testInfo.outputPath("overlapping-replacements.png"),
  });
});

test("discarding while a replacement waits on a save does not write the draft back", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const original = mock.handlers.save_draft;
    const state = window as unknown as { releaseSave: () => void };
    let held = true;
    const gate = new Promise<void>((resolve) => {
      state.releaseSave = resolve;
    });
    mock.handlers.save_draft = async (args: Record<string, unknown>) => {
      if (held) {
        held = false;
        await gate;
      }
      return original(args);
    };
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("DISCARD ME");
  const callsOf = async (command: string) =>
    (await recordedCalls(page)).filter((c) => c.command === command);

  await emitTauriEvent(page, "deep-link://new-url", [mailto("late")]);
  await expect.poll(async () => (await callsOf("save_draft")).length).toBe(1);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseSave: () => void }).releaseSave(),
  );
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await expect.poll(async () => (await callsOf("delete_draft")).length).toBe(1);
  await page.waitForTimeout(300);

  const calls = await recordedCalls(page);
  const deleteAt = calls.findIndex((c) => c.command === "delete_draft");
  expect(
    calls.slice(deleteAt + 1).filter((c) => c.command === "save_draft"),
  ).toHaveLength(0);
  await attachIpcLog(page, testInfo);
});

test("sending while a replacement waits on a save creates no ghost draft", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const original = mock.handlers.save_draft;
    const state = window as unknown as { releaseSave: () => void };
    let held = true;
    const gate = new Promise<void>((resolve) => {
      state.releaseSave = resolve;
    });
    mock.handlers.save_draft = async (args: Record<string, unknown>) => {
      if (held) {
        held = false;
        await gate;
      }
      return original(args);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.test");
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("SEND ME");
  await page.getByLabel("Message body").pressSequentially("Send body");
  const callsOf = async (command: string) =>
    (await recordedCalls(page)).filter((c) => c.command === command);

  await emitTauriEvent(page, "deep-link://new-url", [mailto("late")]);
  await expect.poll(async () => (await callsOf("save_draft")).length).toBe(1);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForTimeout(200);
  expect(await callsOf("send_message")).toHaveLength(0);

  await page.evaluate(() =>
    (window as unknown as { releaseSave: () => void }).releaseSave(),
  );
  await expect.poll(async () => (await callsOf("send_message")).length).toBe(1);
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const sends = await callsOf("send_message");
  expect((sends[0].args as { draft: { id?: string } }).draft.id).toBe(
    "draft-2",
  );
  expect(await callsOf("save_draft")).toHaveLength(1);
  await attachIpcLog(page, testInfo);
});
