import type { TestInfo } from "@playwright/test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";
import { recordIpc, recordedCalls } from "./ipc-recorder";

test.use({ trace: "off" });

type RaceWindow = Window & { finishAutomaticRead?: () => void };

const artifactDirectory = resolve(
  "artifacts/codebase-fixes-2026-10-29/frontend/reader-content-race",
);

function artifactSlug(testInfo: TestInfo) {
  return `${testInfo.project.name}-${testInfo.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);
}

async function holdReadFor(page: import("@playwright/test").Page, id: number) {
  await page.addInitScript((messageId) => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const original = mock.handlers.set_message_flags;
    mock.handlers.set_message_flags = (args) => {
      if (args.messageId === messageId && args.isRead === true) {
        return new Promise<void>((resolveRead) => {
          (window as RaceWindow).finishAutomaticRead = resolveRead;
        });
      }
      return original(args);
    };
  }, id);
}

async function makeTrashNextMessagePartial(
  page: import("@playwright/test").Page,
  id: number,
) {
  await page.addInitScript((messageId) => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const originalList = mock.handlers.list_messages;
    const originalGet = mock.handlers.get_message;
    const partialAttachments = [
      {
        id: "partial-report",
        filename: "Quarterly report.pdf",
        contentType: "application/pdf",
        size: 0,
        contentId: null,
        inline: false,
      },
    ];
    const fullAttachments = [
      {
        id: "full-report",
        filename: "Quarterly report.pdf",
        contentType: "application/pdf",
        size: 12_400_000,
        contentId: null,
        inline: false,
      },
    ];
    let downloaded = false;

    mock.handlers.list_messages = (args) => {
      const result = originalList(args) as {
        items: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
      if (Number(args.mailboxId) !== 3) return result;
      return {
        ...result,
        items: result.items.map((item) =>
          Number(item.id) === messageId ? { ...item, isRead: false } : item,
        ),
      };
    };
    mock.handlers.get_message = (args) => {
      const result = originalGet(args) as Record<string, unknown>;
      if (Number(args.messageId) !== messageId) return result;
      return {
        ...result,
        isRead: false,
        bodyPartial: !downloaded,
        textBody: "A partially downloaded reader body.",
        attachments: downloaded ? fullAttachments : partialAttachments,
      };
    };
    mock.handlers.download_full_message = (args) => {
      downloaded = true;
      return mock.handlers.get_message(args);
    };
  }, id);
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
    `postal-snap-reader-${testInfo.project.name}-${testInfo.testId}-${testInfo.retry}.zip`,
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
  test(`opening keeps the full downloaded message after automatic read (${density}, ${scale * 100}%)`, async ({
    page,
  }) => {
    await holdReadFor(page, 10);
    await page.goto(`/?partialMessage=1&density=${density}&scale=${scale}`);
    await page.getByText("Weekend plans", { exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => typeof (window as RaceWindow).finishAutomaticRead),
      )
      .toBe("function");

    await page
      .getByRole("button", { name: "Download full message", exact: true })
      .click();
    await expect(
      page.locator('[data-attachment-id="full-report"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add star", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Remove star", exact: true }),
    ).toBeVisible();

    await page.evaluate(() => (window as RaceWindow).finishAutomaticRead?.());

    await expect(
      page.getByRole("button", { name: "Download full message", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-attachment-id="full-report"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-attachment-id="partial-report"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove star", exact: true }),
    ).toBeVisible();
  });

  test(`late mark-read cannot restore a prior selection or mailbox (${density}, ${scale * 100}%)`, async ({
    page,
  }) => {
    await holdReadFor(page, 10);
    await page.goto(
      `/?threadGap=1&partialMessage=1&density=${density}&scale=${scale}`,
    );
    await page.getByText("Weekend plans", { exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => typeof (window as RaceWindow).finishAutomaticRead),
      )
      .toBe("function");

    await page.getByText("Library hours", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Library hours" }),
    ).toBeVisible();
    await page
      .getByRole("complementary", { name: "Accounts and mailboxes" })
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Library hours" }),
    ).toHaveCount(0);

    await page.evaluate(() => (window as RaceWindow).finishAutomaticRead?.());
    await expect(
      page.getByRole("heading", { name: "Weekend plans" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Library hours" }),
    ).toHaveCount(0);
  });

  test(`next-message opening keeps its full content and star after automatic read (${density}, ${scale * 100}%)`, async ({
    page,
  }) => {
    await holdReadFor(page, 43);
    await makeTrashNextMessagePartial(page, 43);
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`/?trashThread=1&density=${density}&scale=${scale}`);
    await page.getByRole("button", { name: /^Trash/ }).click();
    await page.getByRole("treeitem", { name: /Old receipt/i }).click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menuitem", { name: "Delete conversation", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Keep this" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => typeof (window as RaceWindow).finishAutomaticRead),
      )
      .toBe("function");

    await page
      .getByRole("button", { name: "Download full message", exact: true })
      .click();
    await expect(
      page.locator('[data-attachment-id="full-report"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add star", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Remove star", exact: true }),
    ).toBeVisible();

    await page.evaluate(() => (window as RaceWindow).finishAutomaticRead?.());

    await expect(
      page.getByRole("button", { name: "Download full message", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-attachment-id="full-report"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-attachment-id="partial-report"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove star", exact: true }),
    ).toBeVisible();
  });
}
