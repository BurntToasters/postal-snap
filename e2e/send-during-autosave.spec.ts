import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Send starts while an autosave is in flight, so send_message carries no
//    draft id and backend cleanup removes nothing.
// 2. The late save_draft creates a second draft of the sent mail (ghost draft).
// 3. An autosave starts after send begins and writes a draft for the sent mail.
// 4. The sent draft id differs from the id the autosave returned.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = (
      window as unknown as {
        __POSTAL_SNAP_MOCK__: {
          handlers: Record<string, (args: unknown) => unknown>;
        };
      }
    ).__POSTAL_SNAP_MOCK__;
    const original = mock.handlers.save_draft;
    // Only the first save waits, until the test releases it.
    let held = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (window as unknown as { __releaseSave: () => void }).__releaseSave = () =>
      release();
    mock.handlers.save_draft = async (args: unknown) => {
      if (held) {
        held = false;
        await gate;
      }
      return original(args);
    };
  });
});

test("a send waits for an in-flight autosave and reuses its draft id", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Race check");
  await page.getByLabel("Message body").pressSequentially("Body text");
  const callsOf = async (command: string) =>
    (await recordedCalls(page)).filter((call) => call.command === command);
  // The Send button is disabled while saving, so this uses the keyboard in
  // the same task as the blur: the send sees the pre-save render state.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(async () => (await callsOf("save_draft")).length).toBe(1);

  await page.waitForTimeout(300);
  expect(await callsOf("send_message")).toHaveLength(0);

  await page.evaluate(() =>
    (window as unknown as { __releaseSave: () => void }).__releaseSave(),
  );
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const sends = await callsOf("send_message");
  expect(sends).toHaveLength(1);
  // The mock returns draft-2 for the first save of a new message.
  expect((sends[0].args as { draft: { id?: string } }).draft.id).toBe(
    "draft-2",
  );
  // No save may follow the send, or it would create a ghost draft.
  expect(await callsOf("save_draft")).toHaveLength(1);
  await attachIpcLog(page, testInfo);
});
