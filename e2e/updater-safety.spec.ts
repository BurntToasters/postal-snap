import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";
import { emitTauriEvent, recordIpc, recordedCalls } from "./ipc-recorder";

// Failure modes: a discarded package relaunches without installation; closing
// an active package breaks installation; failed downloads leak native resources.
test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

async function artifact(page: Page, name: string) {
  mkdirSync("test-results/updater-safety", { recursive: true });
  writeFileSync(
    `test-results/updater-safety/${name}.json`,
    JSON.stringify(await recordedCalls(page), null, 2),
  );
}

async function ready(page: Page) {
  await page.goto("/?update=1&channel=auto");
  await expect(
    page.getByRole("button", { name: "Update Ready · Click to Restart" }),
  ).toBeVisible();
}

async function advanced(page: Page) {
  await page.getByRole("tab", { name: "Advanced", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Update channel" })
    .selectOption("stable");
}

test("channel change while waiting cancels the old installation", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    mock.handlers.begin_update_install = () =>
      new Promise<void>((resolve) => {
        (window as unknown as { releaseInstall: () => void }).releaseInstall =
          resolve;
      });
    mock.handlers["plugin:updater|check"] = () => null;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Restart Postal Snap" }).click();
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("begin_update_install");
  await advanced(page);
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter(
          (c) => c.command === "plugin:resources|close",
        ).length,
    )
    .toBe(2);
  await page.evaluate(() =>
    (window as unknown as { releaseInstall: () => void }).releaseInstall(),
  );
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("release_update_install");
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter(
          (c) => c.command === "plugin:updater|check",
        ).length,
    )
    .toBe(2);
  const calls = await recordedCalls(page);
  expect(calls.map((c) => c.command)).not.toContain("plugin:updater|install");
  expect(calls.map((c) => c.command)).not.toContain("relaunch_app");
  await artifact(page, "channel-wait");
});

test("channel change while preparing relaunch cancels and clears its marker", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    mock.handlers.prepare_update_relaunch = () =>
      new Promise<void>((resolve) => {
        (window as unknown as { releaseMarker: () => void }).releaseMarker =
          resolve;
      });
    mock.handlers["plugin:updater|check"] = () => null;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Restart Postal Snap" }).click();
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("prepare_update_relaunch");
  await advanced(page);
  await page.evaluate(() =>
    (window as unknown as { releaseMarker: () => void }).releaseMarker(),
  );
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("release_update_install");
  const commands = (await recordedCalls(page)).map((c) => c.command);
  expect(commands).toContain("clear_update_relaunch");
  expect(commands).not.toContain("plugin:updater|install");
  expect(commands).not.toContain("relaunch_app");
  await artifact(page, "channel-marker");
});

test("quit still exits when a channel change discards the waiting update", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    mock.handlers.begin_update_install = () =>
      new Promise<void>((resolve) => {
        (window as unknown as { releaseInstall: () => void }).releaseInstall =
          resolve;
      });
    mock.handlers["plugin:updater|check"] = () => null;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Advanced", exact: true }).click();
  await emitTauriEvent(page, "tray-quit", null);
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("begin_update_install");
  await page
    .getByRole("combobox", { name: "Update channel" })
    .selectOption("stable");
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter(
          (c) => c.command === "plugin:resources|close",
        ).length,
    )
    .toBe(2);
  await page.evaluate(() =>
    (window as unknown as { releaseInstall: () => void }).releaseInstall(),
  );
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("quit_app");
  const commands = (await recordedCalls(page)).map((c) => c.command);
  expect(commands).toContain("release_update_install");
  expect(commands).not.toContain("plugin:updater|install");
  expect(commands).not.toContain("relaunch_app");
  await artifact(page, "channel-quit");
});

test("failed restart can retry without reinstalling an applied update", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    let calls = 0;
    mock.handlers.relaunch_app = () => {
      calls++;
      if (calls === 1) throw new Error("Injected restart failure");
    };
    mock.handlers.show_native_message = () => undefined;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Restart Postal Snap" }).click();
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("release_update_install");
  await page.getByRole("button", { name: "Restart Postal Snap" }).click();
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter((c) => c.command === "relaunch_app")
          .length,
    )
    .toBe(2);
  expect(
    (await recordedCalls(page)).filter(
      (c) => c.command === "plugin:updater|install",
    ),
  ).toHaveLength(1);
  await artifact(page, "restart-retry");
});

test("channel change does not close a package during native installation", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    mock.handlers["plugin:updater|install"] = () =>
      new Promise<void>((resolve) => {
        (window as unknown as { releaseInstall: () => void }).releaseInstall =
          resolve;
      });
    mock.handlers["plugin:updater|check"] = () => null;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Restart Postal Snap" }).click();
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("plugin:updater|install");
  await advanced(page);
  await expect
    .poll(async () =>
      (await recordedCalls(page)).some(
        (c) =>
          c.command === "set_update_ready" &&
          (c.args as { ready: boolean }).ready === false,
      ),
    )
    .toBe(true);
  expect(
    (await recordedCalls(page)).filter(
      (c) => c.command === "plugin:resources|close",
    ),
  ).toHaveLength(0);
  await page.evaluate(() =>
    (window as unknown as { releaseInstall: () => void }).releaseInstall(),
  );
  await expect
    .poll(async () => (await recordedCalls(page)).map((c) => c.command))
    .toContain("relaunch_app");
  await artifact(page, "channel-install");
});

for (const mode of ["background", "interactive"] as const) {
  test(`${mode} failed downloads release update resources`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const mock = window.__POSTAL_SNAP_MOCK__!;
      let next = 700;
      mock.handlers["plugin:updater|check"] = () => ({
        rid: next++,
        currentVersion: "0.5.1",
        version: "9.9.9",
      });
      mock.handlers["plugin:updater|download"] = () => {
        throw new Error("Injected network loss");
      };
      mock.handlers.show_native_message = () => undefined;
    });
    await page.goto("/?channel=stable");
    await expect
      .poll(
        async () =>
          (await recordedCalls(page)).filter(
            (c) => c.command === "plugin:updater|download",
          ).length,
      )
      .toBe(1);
    for (let n = 2; n <= 3; n++) {
      await page.evaluate(async (kind) => {
        const source = "/src/update.ts";
        const update = await import(/* @vite-ignore */ source);
        if (kind === "interactive") await update.checkUpdateInteractive();
        else await update.runUpdateSingleFlight().catch(() => undefined);
      }, mode);
      await expect
        .poll(
          async () =>
            (await recordedCalls(page)).filter(
              (c) => c.command === "plugin:updater|download",
            ).length,
        )
        .toBe(n);
    }
    await expect
      .poll(
        async () =>
          (await recordedCalls(page)).filter(
            (c) => c.command === "plugin:resources|close",
          ).length,
      )
      .toBe(3);
    await artifact(page, `failed-${mode}`);
  });
}
