import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Page, TestInfo } from "@playwright/test";

export interface RecordedCall {
  command: string;
  args: unknown;
}

type TestWindow = Window & {
  __POSTAL_SNAP_TEST__?: { ipcCalls: RecordedCall[] };
  __TAURI_INTERNALS__: {
    invoke: (command: string, args?: unknown) => Promise<unknown>;
  };
};

// The mock records every non-event invoke into __POSTAL_SNAP_TEST__.ipcCalls
// (see e2e/mock/window-events.ts). These helpers only read or emit.

/** Ordered IPC calls of the run, including plugin calls. */
export async function ipcCalls(page: Page): Promise<RecordedCall[]> {
  return page.evaluate(
    () =>
      (window as unknown as TestWindow).__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
}

/** Command names only; `plugin:` commands are skipped unless requested. */
export async function ipcCommands(
  page: Page,
  options: { includePlugin?: boolean } = {},
): Promise<string[]> {
  const commands = (await ipcCalls(page)).map((call) => call.command);
  return options.includePlugin
    ? commands
    : commands.filter((command) => !command.startsWith("plugin:"));
}

/** Test-relative artifact folder: artifacts/0.5.2/<spec name>/. */
function artifactPath(testInfo: TestInfo, file: string): string {
  const spec = path.basename(testInfo.file).replace(/\.spec\.ts$/, "");
  return path.join(process.cwd(), "artifacts", "0.5.2", spec, file);
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-");
}

/** Writes and attaches the ordered IPC log. Returns the calls. */
export async function attachIpcLog(
  page: Page,
  testInfo: TestInfo,
  name = "ipc-calls",
): Promise<RecordedCall[]> {
  const calls = await ipcCalls(page);
  const body = JSON.stringify(calls, null, 2);
  const file = artifactPath(testInfo, `${safeName(name)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await testInfo.attach(`${name}.json`, {
    body,
    contentType: "application/json",
  });
  return calls;
}

/**
 * Screenshot plus IPC log, written to artifacts/0.5.2/<spec>/<name>.{json,png}
 * and attached. `extra` fields are merged into the JSON beside ipcCalls.
 */
export async function attachArtifacts(
  page: Page,
  testInfo: TestInfo,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const calls = await ipcCalls(page);
  const body = JSON.stringify({ ...extra, ipcCalls: calls }, null, 2);
  const stem = safeName(name);
  const jsonFile = artifactPath(testInfo, `${stem}.json`);
  await mkdir(path.dirname(jsonFile), { recursive: true });
  await writeFile(jsonFile, body);
  await testInfo.attach(`${name}-ipc-calls.json`, {
    body,
    contentType: "application/json",
  });
  const png = await page.screenshot({
    path: artifactPath(testInfo, `${stem}.png`),
  });
  await testInfo.attach(`${name}.png`, { body: png, contentType: "image/png" });
}

/** Emit a Tauri event to the page, as Rust would. */
export async function emitTauriEvent(
  page: Page,
  event: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ([name, body]) =>
      (window as unknown as TestWindow).__TAURI_INTERNALS__.invoke(
        "plugin:event|emit",
        { event: name, payload: body },
      ),
    [event, payload] as const,
  );
}

/** afterEach hook: artifacts for each test, named after its title. */
export async function attachArtifactsAfterEach(
  { page }: { page: Page },
  testInfo: TestInfo,
): Promise<void> {
  // Capture must never fail the test, even when the page has crashed.
  try {
    if (page.isClosed() || page.url() === "about:blank") return;
    const name = testInfo.title.replace(/[^\w.-]+/g, "-").slice(0, 100);
    await attachArtifacts(page, testInfo, name);
  } catch {
    return;
  }
}
