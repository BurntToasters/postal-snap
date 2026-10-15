import { mkdirSync, writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Restart to Update from the banner does not reopen the window.
// 2. A ready update never installs while the app sits hidden in the tray.
// 3. A background install starts while the window is visible.
// 4. A background install starts while a message is being composed.
// 7. Check for Updates downloads an update but offers only OK, no restart.
// 5. Quit with a ready update relaunches the app (Windows installer /R).
// 6. An update relaunch replays the startup mailto: argument.
// 8. No periodic check after sleep or while hidden in the tray.
// 9. A failed download counts as a finished check, skipping the retry.
// P1-P4 beta retry, native resource release, stale interactive message.
// Each test writes its recorded updater IPC to test-results/updater-*.json.

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
  await page.goto("/?update=1");
  await waitForUpdateReady(page);

  await page.evaluate(() => {
    const state = window.__POSTAL_SNAP_TEST__;
    if (state) state.backgroundUpdateAllowed = true;
  });
  // Rust emits this after the window has waited in the tray.
  await emitNative(page, "background-update-due");

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
  await page.goto("/?update=1");
  await waitForUpdateReady(page);

  await emitNative(page, "background-update-due");

  await expect
    .poll(() => commands(page))
    .toContain("background_update_allowed");
  expect(await commands(page)).not.toContain("install");
  expect(await commands(page)).not.toContain("relaunch_app");
  await saveArtifact(page, testInfo);
});

test("waits while a message is being composed", async ({ page }, testInfo) => {
  await page.goto("/?update=1");
  await waitForUpdateReady(page);
  await page.getByRole("button", { name: "Compose" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.evaluate(() => {
    const state = window.__POSTAL_SNAP_TEST__;
    if (state) state.backgroundUpdateAllowed = true;
  });
  await emitNative(page, "background-update-due");
  // Blocked: ask Rust to wait again instead of installing.
  await expect
    .poll(() => commands(page))
    .toContain("schedule_background_update");

  expect(await commands(page)).not.toContain("install");
  expect(await commands(page)).not.toContain("relaunch_app");
  await saveArtifact(page, testInfo);
});

test("Check for Updates offers Restart Now after a new download", async ({
  page,
}, testInfo) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/?updateLater=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Updates" }).click();
  await page.getByRole("button", { name: "Check for updates" }).click();

  await expect.poll(() => commands(page)).toContain("relaunch_app");
  const calls = await updateCalls(page);
  expect(calls).toContainEqual(
    expect.objectContaining({
      command: "show_native_confirm",
      args: expect.objectContaining({
        okLabel: "Restart Now",
        cancelLabel: "Later",
      }),
    }),
  );
  expect(calls).toContainEqual({
    command: "prepare_update_relaunch",
    args: { mode: "window" },
  });
  await saveArtifact(page, testInfo);
});

test("downloads an update when Rust reports a periodic check is due", async ({
  page,
}, testInfo) => {
  // First (startup) check finds nothing; the update ships while asleep.
  await page.goto("/?updateLater=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await expect.poll(() => commands(page)).toContain("mark_update_checked");
  expect(await commands(page)).not.toContain("download");

  // Rust emits this from its wall-clock timer, even while hidden.
  await emitNative(page, "update-check-due");

  await waitForUpdateReady(page);
  const checks = (await commands(page)).filter((c) => c === "check");
  expect(checks).toHaveLength(2);
  expect(await commands(page)).toContain("download");
  await saveArtifact(page, testInfo);
});

test("a failed download does not count as a finished check", async ({
  page,
}, testInfo) => {
  await page.goto("/?update=1&downloadFails=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await expect.poll(() => commands(page)).toContain("download");
  await page.waitForTimeout(300);
  expect(await commands(page)).not.toContain("mark_update_checked");
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

// Update channel (0.4.3). Failure modes: C2 stable offered beta, C3 stale
// download after a switch, C7 picker on store builds, C10 Auto detection,
// C11 channel lost on reload, C16 tab not named Advanced.
const channelLog: Record<string, unknown> = {};

async function checkTargets(page: Page): Promise<Array<string | null>> {
  return (await updateCalls(page))
    .filter((call) => call.command === "check")
    .map((call) => (call.args.target as string | undefined) ?? null);
}

async function openAdvanced(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Advanced" }).click();
}

function channelPicker(page: Page) {
  return page.getByRole("combobox", { name: "Update channel" });
}

async function waitForStartupCheck(page: Page) {
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await expect.poll(() => checkTargets(page)).toHaveLength(1);
}

test.afterAll(() => {
  mkdirSync("artifacts/0.4.3", { recursive: true });
  writeFileSync(
    "artifacts/0.4.3/updater-channel-calls.json",
    JSON.stringify(channelLog, null, 2),
  );
});

test("Advanced tab is named Advanced and shows the channel picker", async ({
  page,
}) => {
  await page.goto("/");
  await waitForStartupCheck(page);
  await openAdvanced(page);
  await expect(
    page.getByRole("tab", { name: "Privacy & Security" }),
  ).toHaveCount(0);
  await expect(channelPicker(page)).toHaveValue("auto");
});

test("store builds hide the picker and never check", async ({ page }) => {
  await page.goto("/?store=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await openAdvanced(page);
  await expect(page.getByRole("tab", { name: "Advanced" })).toBeVisible();
  await expect(channelPicker(page)).toHaveCount(0);
  expect(await checkTargets(page)).toEqual([]);
});

test("Stable checks without a target", async ({ page }) => {
  await page.goto("/?channel=stable&version=0.5.0-beta.1");
  await waitForStartupCheck(page);
  expect(await checkTargets(page)).toEqual([null]);
  channelLog["stable"] = await checkTargets(page);
});

test("Beta checks the beta target", async ({ page }) => {
  await page.goto("/?channel=beta");
  await waitForStartupCheck(page);
  expect(await checkTargets(page)).toEqual(["darwin-beta"]);
  channelLog["beta"] = await checkTargets(page);
});

test("Auto on a pre-release checks beta", async ({ page }) => {
  await page.goto("/?version=0.5.0-beta.1");
  await waitForStartupCheck(page);
  expect(await checkTargets(page)).toEqual(["darwin-beta"]);
  channelLog["auto-0.5.0-beta.1"] = await checkTargets(page);
});

test("Auto on a stable release checks without a target", async ({ page }) => {
  await page.goto("/");
  await waitForStartupCheck(page);
  expect(await checkTargets(page)).toEqual([null]);
  channelLog["auto-0.4.3"] = await checkTargets(page);
});

test("picking a channel applies to the next check and survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await waitForStartupCheck(page);
  await openAdvanced(page);
  await channelPicker(page).selectOption("beta");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.savedSettings.at(-1) as
            { updateChannel?: string } | undefined,
      ),
    )
    .toMatchObject({ updateChannel: "beta" });
  await page.keyboard.press("Escape");
  await emitNative(page, "update-check-due");
  await expect.poll(() => checkTargets(page)).toEqual([null, "darwin-beta"]);
  channelLog["ui-beta"] = await checkTargets(page);

  await page.reload();
  await openAdvanced(page);
  await expect(channelPicker(page)).toHaveValue("beta");
});

test("switching channel discards a ready update and re-checks", async ({
  page,
}) => {
  await page.goto("/?update=1&version=0.5.0-beta.1");
  await waitForUpdateReady(page);
  await openAdvanced(page);
  await channelPicker(page).selectOption("stable");
  await page.keyboard.press("Escape");
  // The old download is dropped, then the stable feed is checked afresh.
  await expect
    .poll(async () =>
      (await updateCalls(page))
        .filter((call) => call.command === "set_update_ready")
        .map((call) => call.args.ready),
    )
    .toEqual([true, false, true]);
  const checks = (await updateCalls(page)).filter(
    (call) => call.command === "check",
  );
  expect(checks.at(0)?.args.target).toBe("darwin-beta");
  expect(checks.at(-1)?.args.target).toBeUndefined();
});

// Polish round: P1 beta feed gap, P2 stable never retries, P3 resource leak,
// P4 silent stale check.
const polishLog: Record<string, unknown> = {};

test.afterAll(() => {
  mkdirSync("artifacts/0.4.3", { recursive: true });
  writeFileSync(
    "artifacts/0.4.3/updater-polish-calls.json",
    JSON.stringify(polishLog, null, 2),
  );
});

for (const flaky of ["1", "empty"]) {
  test(`P1 beta retries once after a flaky first check (${flaky})`, async ({
    page,
  }) => {
    await page.goto(`/?channel=beta&update=1&betaFlaky=${flaky}`);
    await waitForUpdateReady(page);
    expect(await checkTargets(page)).toEqual(["darwin-beta", "darwin-beta"]);
    polishLog[`beta-flaky-${flaky}`] = await updateCalls(page);
  });
}

test("P2 stable makes exactly one check and never retries", async ({
  page,
}) => {
  await page.goto("/?channel=stable&betaFlaky=1");
  await waitForStartupCheck(page);
  await page.waitForTimeout(2600);
  expect(await checkTargets(page)).toEqual([null]);
  polishLog["stable-single"] = await updateCalls(page);
});

test("P3 switching channel closes the ready update's resource", async ({
  page,
}) => {
  await page.goto("/?update=1");
  await waitForUpdateReady(page);
  expect(await commands(page)).not.toContain("resources-close");
  await openAdvanced(page);
  await channelPicker(page).selectOption("stable");
  await expect
    .poll(async () =>
      (await updateCalls(page)).filter((c) => c.command === "resources-close"),
    )
    // The update and its downloaded bytes are separate resources.
    .toEqual([
      { command: "resources-close", args: { rid: 72 } },
      { command: "resources-close", args: { rid: 71 } },
    ]);
  polishLog["discard-closes"] = await updateCalls(page);
});

test("P3 a stale download is closed, then re-checked on the new channel", async ({
  page,
}) => {
  await page.goto("/?update=1&downloadSlow=1&channel=beta");
  await expect.poll(() => commands(page)).toContain("download");
  await openAdvanced(page);
  await channelPicker(page).selectOption("stable");
  await expect
    .poll(() => commands(page), { timeout: 10_000 })
    .toContain("resources-close");
  // The stale beta download never became ready; the stable re-run did.
  await expect(
    page.getByRole("button", { name: "Update Ready · Click to Restart" }),
  ).toBeVisible({ timeout: 10_000 });
  expect(await checkTargets(page)).toEqual(["darwin-beta", null]);
  polishLog["stale-background"] = await updateCalls(page);
});

test("switching channel starts a check with the new target", async ({
  page,
}) => {
  await page.goto("/?channel=stable");
  await waitForStartupCheck(page);
  await openAdvanced(page);
  await channelPicker(page).selectOption("beta");
  await expect.poll(() => checkTargets(page)).toEqual([null, "darwin-beta"]);
  polishLog["switch-checks"] = await checkTargets(page);
});

test("P4 a stale interactive check re-runs and never says up to date", async ({
  page,
}) => {
  const messages: string[] = [];
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  await page.goto("/?updateLater=1&downloadSlow=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Updates" }).click();
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect.poll(() => commands(page)).toContain("download");
  await page.getByRole("tab", { name: "Advanced" }).click();
  await channelPicker(page).selectOption("beta");
  await expect
    .poll(() => commands(page), { timeout: 10_000 })
    .toContain("resources-close");
  // The re-run on beta finds the update again and offers the restart.
  await expect
    .poll(() => messages.join("|"), { timeout: 10_000 })
    .toContain("Update Ready");
  expect(messages.join("|")).not.toMatch(/up to date|Check again/);
  expect(await checkTargets(page)).toEqual([null, null, "darwin-beta"]);
  await page.getByRole("tab", { name: "Updates" }).click();
  await expect(
    page.getByRole("button", { name: "Check for updates" }),
  ).toBeEnabled();
  polishLog["stale-interactive"] = {
    messages,
    calls: await updateCalls(page),
  };
});

for (const [name, query] of [
  ["comfortable", "?"],
  ["compact", "?density=compact&"],
  ["200-text", "?scale=2&"],
] as const) {
  test(`Advanced tab screenshot ${name}`, async ({ page }) => {
    await page.goto(`/${query}version=0.4.3`);
    await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
    await openAdvanced(page);
    await expect(channelPicker(page)).toBeVisible();
    await channelPicker(page).scrollIntoViewIfNeeded();
    mkdirSync("artifacts/0.4.3", { recursive: true });
    await page.screenshot({
      animations: "disabled",
      path: `artifacts/0.4.3/advanced-tab-${name}.png`,
    });
  });
}
