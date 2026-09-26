import { mkdirSync, writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Restart to Update from the banner does not reopen the window.
// 2. A ready update never installs while the app sits hidden in the tray.
// 3. A background install starts while the window is visible.
// 4. A background install starts while a message is being composed.
// 5. Quit with a ready update relaunches the app (Windows installer /R).
// 6. An update relaunch replays the startup mailto: argument.
// Each test writes its recorded updater IPC to test-results/updater-*.json.

const BACKGROUND_DELAY = "03:05";

test.beforeEach(async ({ page }) => installMockIpc(page));

type UpdateCall = { command: string; args: Record<string, unknown> };

function updateCalls(page: Page): Promise<UpdateCall[]> {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.updateCalls ?? []);
}

async function commands(page: Page): Promise<string[]> {
  return (await updateCalls(page)).map((call) => call.command);
}

async function emitNative(page: Page, event: string) {
  await page.evaluate((event) => {
    const state = window.__POSTAL_SNAP_TEST__;
    if (!state) return;
    for (const handler of state.eventListeners.get(event) ?? []) {
      state.callbacks.get(handler)?.({ event, id: handler, payload: null });
    }
  }, event);
}

async function waitForUpdateReady(page: Page) {
  await expect(
    page.getByRole("button", { name: "Update Ready · Click to Restart" }),
  ).toBeVisible();
  await expect.poll(() => commands(page)).toContain("set_update_ready");
}

async function saveArtifact(page: Page, testInfo: TestInfo) {
  mkdirSync("test-results", { recursive: true });
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  writeFileSync(
    `test-results/updater-${slug}.json`,
    JSON.stringify(await updateCalls(page), null, 2),
  );
}

test("restarts into the window from the update banner", async ({
  page,
}, testInfo) => {
  await page.goto("/?update=1");
  await waitForUpdateReady(page);

  await page
    .getByRole("button", { name: "Update Ready · Click to Restart" })
    .click();

  await expect.poll(() => commands(page)).toContain("relaunch_app");
  const calls = await updateCalls(page);
  expect(calls).toContainEqual({
    command: "prepare_update_relaunch",
    args: { mode: "window" },
  });
  expect(calls.find((call) => call.command === "install")?.args).toMatchObject({
    restartAfterInstall: true,
  });
  expect(await commands(page)).not.toContain("quit_app");
  await saveArtifact(page, testInfo);
});

test("installs quietly and restarts to the tray while hidden", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await page.goto("/?update=1");
  await waitForUpdateReady(page);

  await page.evaluate(() => {
    const state = window.__POSTAL_SNAP_TEST__;
    if (state) state.backgroundUpdateAllowed = true;
  });
  await emitNative(page, "main-window-hidden");
  expect(await commands(page)).not.toContain("install");
  await page.clock.fastForward(BACKGROUND_DELAY);

  await expect.poll(() => commands(page)).toContain("relaunch_app");
  const calls = await updateCalls(page);
  expect(calls).toContainEqual({
    command: "prepare_update_relaunch",
    args: { mode: "background" },
  });
  expect(calls.find((call) => call.command === "install")?.args).toMatchObject({
    restartAfterInstall: true,
  });
  expect(await commands(page)).not.toContain("quit_app");
  await saveArtifact(page, testInfo);
});

test("waits while the window is visible", async ({ page }, testInfo) => {
  await page.clock.install();
  await page.goto("/?update=1");
  await waitForUpdateReady(page);

  await emitNative(page, "main-window-hidden");
  await page.clock.fastForward(BACKGROUND_DELAY);

  await expect
    .poll(() => commands(page))
    .toContain("background_update_allowed");
  expect(await commands(page)).not.toContain("install");
  expect(await commands(page)).not.toContain("relaunch_app");
  await saveArtifact(page, testInfo);
});

test("waits while a message is being composed", async ({ page }, testInfo) => {
  await page.clock.install();
  await page.goto("/?update=1");
  await waitForUpdateReady(page);
  await page.getByRole("button", { name: "Compose" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.evaluate(() => {
    const state = window.__POSTAL_SNAP_TEST__;
    if (state) state.backgroundUpdateAllowed = true;
  });
  await emitNative(page, "main-window-hidden");
  await page.clock.fastForward(BACKGROUND_DELAY);
  await expect
    .poll(() => commands(page))
    .toContain("background_update_allowed");
  await page.clock.fastForward(BACKGROUND_DELAY);

  expect(await commands(page)).not.toContain("install");
  expect(await commands(page)).not.toContain("relaunch_app");
  await saveArtifact(page, testInfo);
});

test("quitting from the tray installs without reopening", async ({
  page,
}, testInfo) => {
  await page.goto("/?update=1");
  await waitForUpdateReady(page);

  await emitNative(page, "tray-quit");

  await expect.poll(() => commands(page)).toContain("quit_app");
  const calls = await updateCalls(page);
  expect(calls.find((call) => call.command === "install")?.args).toMatchObject({
    restartAfterInstall: false,
  });
  expect(await commands(page)).not.toContain("relaunch_app");
  expect(await commands(page)).not.toContain("prepare_update_relaunch");
  await saveArtifact(page, testInfo);
});

test("opens a startup mailto link on a normal launch", async ({ page }) => {
  await page.goto("/?startupMailto=1");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("does not replay the startup mailto link after an update relaunch", async ({
  page,
}, testInfo) => {
  await page.goto("/?startupMailto=1&updateRelaunch=window");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await saveArtifact(page, testInfo);
});
