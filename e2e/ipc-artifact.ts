import type { Page, TestInfo } from "@playwright/test";

/** Screenshot plus the recorded IPC calls, attached for repeatable review. */
export async function attachArtifacts(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  await testInfo.attach(`${name}-ipc-calls.json`, {
    body: JSON.stringify(calls, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach(`${name}.png`, {
    body: await page.screenshot({ path: `test-results/${name}.png` }),
    contentType: "image/png",
  });
}

export async function ipcCommands(page: Page): Promise<string[]> {
  return page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls.map((c) => c.command) ?? [],
  );
}
