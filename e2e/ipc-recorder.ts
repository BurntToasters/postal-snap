import type { Page, TestInfo } from "@playwright/test";

export interface RecordedCall {
  command: string;
  args: unknown;
}

type RecorderWindow = Window & {
  __IPC_CALLS__?: RecordedCall[];
  __TAURI_INTERNALS__: {
    invoke: (command: string, args?: unknown) => Promise<unknown>;
  };
};

// Wraps the mocked invoke to keep an ordered call log. Install after
// installMockIpc so the mock invoke already exists. Event plumbing is skipped.
export async function recordIpc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as RecorderWindow;
    const calls: RecordedCall[] = [];
    scope.__IPC_CALLS__ = calls;
    const internals = scope.__TAURI_INTERNALS__;
    const original = internals.invoke.bind(internals);
    internals.invoke = (command, args) => {
      if (!command.startsWith("plugin:event|"))
        calls.push({ command, args: structuredClone(args ?? null) });
      return original(command, args);
    };
  });
}

export async function recordedCalls(page: Page): Promise<RecordedCall[]> {
  return page.evaluate(
    () => (window as unknown as RecorderWindow).__IPC_CALLS__ ?? [],
  );
}

/** Repeatable artifact: the ordered IPC calls of the run. */
export async function attachIpcLog(
  page: Page,
  testInfo: TestInfo,
): Promise<RecordedCall[]> {
  const calls = await recordedCalls(page);
  await testInfo.attach("ipc-calls.json", {
    body: JSON.stringify(calls, null, 2),
    contentType: "application/json",
  });
  return calls;
}

/** Emit a Tauri event to the page, as Rust would. */
export async function emitTauriEvent(
  page: Page,
  event: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ([name, body]) =>
      (window as unknown as RecorderWindow).__TAURI_INTERNALS__.invoke(
        "plugin:event|emit",
        { event: name, payload: body },
      ),
    [event, payload] as const,
  );
}
