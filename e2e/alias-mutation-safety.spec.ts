import type { Page, TestInfo } from "@playwright/test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";
import { recordIpc, recordedCalls } from "./ipc-recorder";

test.use({ trace: "off" });

interface HeldAliasUpdate {
  args: Record<string, unknown>;
  release: () => void;
}

type AliasWindow = Window & {
  finishAliasDiscovery?: () => void;
  aliasUpdates?: HeldAliasUpdate[];
  finishAliasUpdate?: () => void;
};

const artifactDirectory = resolve(
  "artifacts/codebase-fixes-2026-10-29/frontend/alias-mutation-safety",
);

function artifactSlug(testInfo: TestInfo) {
  return `${testInfo.project.name}-${testInfo.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);
}

async function openIdentity(page: Page, density: string, scale: number) {
  await page.goto(`/?density=${density}&scale=${scale}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.context().tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const slug = artifactSlug(testInfo);
  await mkdir(artifactDirectory, { recursive: true });
  const calls = page.isClosed() ? [] : await recordedCalls(page);
  const jsonPath = resolve(artifactDirectory, `${slug}.json`);
  const screenshotPath = resolve(artifactDirectory, `${slug}.png`);
  const tracePath = resolve(artifactDirectory, `${slug}.zip`);
  const temporaryTrace = resolve(
    tmpdir(),
    `postal-snap-alias-${testInfo.project.name}-${testInfo.testId}-${testInfo.retry}.zip`,
  );

  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        project: testInfo.project.name,
        title: testInfo.title,
        status: testInfo.status,
        calls,
      },
      null,
      2,
    )}\n`,
  );
  if (!page.isClosed()) {
    await page.screenshot({ path: screenshotPath });
  }
  await page.context().tracing.stop({ path: temporaryTrace });
  await copyFile(temporaryTrace, tracePath);
  await rm(temporaryTrace, { force: true });
});

const matrix = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

for (const { density, scale } of matrix) {
  test(`alias discovery and removals preserve every queued change (${density}, ${scale * 100}%)`, async ({
    page,
  }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    await openIdentity(page, density, scale);
    await page.getByRole("button", { name: "Detect from iCloud" }).click();
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Remove custom@mydomain.com",
        exact: true,
      }),
    ).toBeVisible();

    await page.evaluate(() => {
      const mock = window.__POSTAL_SNAP_MOCK__!;
      const scope = window as AliasWindow;
      const discover = mock.handlers.discover_account_aliases;
      const update = mock.handlers.update_account_aliases;
      scope.aliasUpdates = [];
      mock.handlers.discover_account_aliases = (args) =>
        new Promise((resolveDiscovery) => {
          scope.finishAliasDiscovery = () => resolveDiscovery(discover(args));
        });
      mock.handlers.update_account_aliases = (args) =>
        new Promise((resolveUpdate) => {
          scope.aliasUpdates?.push({
            args: structuredClone(args),
            release: () => resolveUpdate(update(args)),
          });
        });
    });

    await page.getByRole("button", { name: "Detect from iCloud" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => typeof (window as AliasWindow).finishAliasDiscovery,
        ),
      )
      .toBe("function");
    await page
      .getByRole("button", { name: "Remove alias1@icloud.com", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Remove custom@mydomain.com",
        exact: true,
      })
      .click();

    const mutationsBeforeDiscovery = await page.evaluate(
      () => (window as AliasWindow).aliasUpdates?.length ?? 0,
    );
    expect.soft(mutationsBeforeDiscovery).toBe(0);

    await page.evaluate(() => (window as AliasWindow).finishAliasDiscovery?.());
    await expect(page.locator(".alias-status-message")).toHaveText(
      "Found 2 aliases.",
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as AliasWindow).aliasUpdates?.length ?? 0),
      )
      .toBeGreaterThan(0);

    const firstAliases = await page.evaluate(
      () => (window as AliasWindow).aliasUpdates?.[0]?.args.aliases,
    );
    expect.soft(firstAliases).toEqual(["custom@mydomain.com"]);
    await page.evaluate(() =>
      (window as AliasWindow).aliasUpdates?.[0]?.release(),
    );
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => (window as AliasWindow).aliasUpdates?.length ?? 0),
      )
      .toBe(2);

    const secondAliases = await page.evaluate(
      () => (window as AliasWindow).aliasUpdates?.[1]?.args.aliases,
    );
    expect.soft(secondAliases).toEqual([]);
    await page.evaluate(() =>
      (window as AliasWindow).aliasUpdates?.[1]?.release(),
    );
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Remove custom@mydomain.com",
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test(`alias mutations stay queued across Settings remount (${density}, ${scale * 100}%)`, async ({
    page,
  }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    await openIdentity(page, density, scale);
    await page.getByRole("button", { name: "Detect from iCloud" }).click();
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toBeVisible();

    await page.evaluate(() => {
      const mock = window.__POSTAL_SNAP_MOCK__!;
      const update = mock.handlers.update_account_aliases;
      const scope = window as AliasWindow;
      scope.aliasUpdates = [];
      mock.handlers.update_account_aliases = (args) =>
        new Promise((resolveUpdate) => {
          scope.aliasUpdates?.push({
            args: structuredClone(args),
            release: () => resolveUpdate(update(args)),
          });
        });
    });

    await page
      .getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as AliasWindow).aliasUpdates?.length ?? 0),
      )
      .toBe(1);
    await page.getByRole("button", { name: "Close settings" }).click();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
    await page.getByRole("button", { name: "Identity", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Remove custom@mydomain.com",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Remove custom@mydomain.com",
        exact: true,
      })
      .click();

    const mutationsAfterRemount = await page.evaluate(
      () => (window as AliasWindow).aliasUpdates?.length ?? 0,
    );
    expect.soft(mutationsAfterRemount).toBe(1);
    const firstAliases = await page.evaluate(
      () => (window as AliasWindow).aliasUpdates?.[0]?.args.aliases,
    );
    expect.soft(firstAliases).toEqual(["custom@mydomain.com"]);
    await page.evaluate(() =>
      (window as AliasWindow).aliasUpdates?.[0]?.release(),
    );
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => (window as AliasWindow).aliasUpdates?.length ?? 0),
      )
      .toBe(2);

    const secondAliases = await page.evaluate(
      () => (window as AliasWindow).aliasUpdates?.[1]?.args.aliases,
    );
    expect.soft(secondAliases).toEqual([]);
    await page.evaluate(() =>
      (window as AliasWindow).aliasUpdates?.[1]?.release(),
    );
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Remove custom@mydomain.com",
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test(`duplicate alias is rechecked after queued removal (${density}, ${scale * 100}%)`, async ({
    page,
  }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    await openIdentity(page, density, scale);
    await page.getByRole("button", { name: "Detect from iCloud" }).click();
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toBeVisible();

    await page.evaluate(() => {
      const mock = window.__POSTAL_SNAP_MOCK__!;
      const update = mock.handlers.update_account_aliases;
      const scope = window as AliasWindow;
      scope.aliasUpdates = [];
      mock.handlers.update_account_aliases = (args) =>
        new Promise((resolveUpdate) => {
          scope.aliasUpdates?.push({
            args: structuredClone(args),
            release: () => resolveUpdate(update(args)),
          });
        });
    });

    await page
      .getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as AliasWindow).aliasUpdates?.length ?? 0),
      )
      .toBe(1);

    const input = page.getByRole("textbox", {
      name: "alias@yourdomain.com",
      exact: true,
    });
    await input.fill("alias1@icloud.com");
    await page.getByRole("button", { name: "Add alias", exact: true }).click();
    await expect(input).toHaveValue("alias1@icloud.com");
    expect(
      await page.evaluate(
        () => (window as AliasWindow).aliasUpdates?.length ?? 0,
      ),
    ).toBe(1);

    await page.evaluate(() =>
      (window as AliasWindow).aliasUpdates?.[0]?.release(),
    );
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => (window as AliasWindow).aliasUpdates?.length ?? 0),
      )
      .toBe(2);
    const addedAliases = await page.evaluate(
      () => (window as AliasWindow).aliasUpdates?.[1]?.args.aliases,
    );
    expect(addedAliases).toEqual(["custom@mydomain.com", "alias1@icloud.com"]);
    await page.evaluate(() =>
      (window as AliasWindow).aliasUpdates?.[1]?.release(),
    );
    await expect(
      page.getByRole("button", {
        name: "Remove alias1@icloud.com",
        exact: true,
      }),
    ).toBeVisible();
    await expect(input).toHaveValue("");
  });

  test(`late alias response preserves newer input (${density}, ${scale * 100}%)`, async ({
    page,
  }) => {
    await openIdentity(page, density, scale);
    await page.evaluate(() => {
      const mock = window.__POSTAL_SNAP_MOCK__!;
      const update = mock.handlers.update_account_aliases;
      (window as AliasWindow).finishAliasUpdate = undefined;
      mock.handlers.update_account_aliases = (args) =>
        new Promise((resolveUpdate) => {
          (window as AliasWindow).finishAliasUpdate = () =>
            resolveUpdate(update(args));
        });
    });

    const input = page.getByRole("textbox", {
      name: "alias@yourdomain.com",
      exact: true,
    });
    await input.fill("first@example.test");
    await page.getByRole("button", { name: "Add alias", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => typeof (window as AliasWindow).finishAliasUpdate),
      )
      .toBe("function");
    await input.fill("second@example.test");
    await page.evaluate(() => (window as AliasWindow).finishAliasUpdate?.());

    await expect(
      page.getByRole("button", {
        name: "Remove first@example.test",
        exact: true,
      }),
    ).toBeVisible();
    await expect(input).toHaveValue("second@example.test");
  });
}
