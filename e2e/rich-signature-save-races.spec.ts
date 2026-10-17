import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import type { MockShared } from "./mock/context";

// Failure modes covered here:
// 1. A successful older response replaces a newer rich HTML edit.
// 2. A plain fallback edit is cleared when a delayed save fails.
// 3. Dirty guards miss or discard edits made while a signature save is pending.

const variants = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

async function openSignatureEditor(page: Page, density: string, scale: number) {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?localMail=1&density=${density}&scale=${scale}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();

  const editor = page.getByRole("textbox", {
    name: "Rich signature",
    exact: true,
  });
  const fallback = page.getByLabel("Email signature");
  await editor.fill("Submitted rich signature");
  await fallback.fill("Submitted fallback");
  const boldText = await editor.evaluate((root) => {
    const text = root.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Expected signature text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 9);
    const selection = window.getSelection();
    if (!selection) throw new Error("Selection API unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  });
  expect(boldText).toBe(true);
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(editor.locator("strong")).toHaveText("Submitted");
  return { editor, fallback };
}

async function delayNextSignatureSave(page: Page) {
  await page.evaluate(() => {
    type Control = {
      pending: boolean;
      submitted?: Record<string, unknown>;
      release?: (succeed: boolean) => void;
      dirtyGuardShown?: boolean;
    };
    const browser = window as Window & {
      __POSTAL_SNAP_MOCK__?: MockShared;
      __signatureRaceControl?: Control;
    };
    const mock = browser.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    const original = mock.handlers.update_account_signature;
    if (!original) throw new Error("Signature mock handler was not installed");
    const control: Control = { pending: false };
    browser.__signatureRaceControl = control;
    mock.handlers.update_account_signature = (args) => {
      mock.handlers.update_account_signature = original;
      control.pending = true;
      control.submitted = structuredClone(args);
      return new Promise((resolve, reject) => {
        control.release = (succeed) => {
          control.pending = false;
          if (!succeed) {
            reject(new Error("Synthetic signature save failure."));
            return;
          }
          void Promise.resolve(original(args)).then(resolve, reject);
        };
      });
    };
  });
}

async function releaseSignatureSave(page: Page, succeed: boolean) {
  await page.evaluate((shouldSucceed) => {
    const browser = window as Window & {
      __signatureRaceControl?: {
        release?: (result: boolean) => void;
      };
    };
    const release = browser.__signatureRaceControl?.release;
    if (!release) throw new Error("No delayed signature save to release");
    release(shouldSucceed);
  }, succeed);
}

async function attemptDirtyGuard(page: Page): Promise<boolean> {
  const prompt = page
    .waitForEvent("dialog", { timeout: 3000 })
    .then(async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      await dialog.dismiss();
      return true;
    })
    .catch((cause: unknown) => {
      if (cause instanceof Error && cause.name === "TimeoutError") return false;
      throw cause;
    });
  await page.getByRole("tab", { name: "General", exact: true }).click();
  const shown = await prompt;
  if (!shown) {
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await page.getByRole("button", { name: "Identity", exact: true }).click();
  } else {
    await expect(
      page.getByRole("tab", { name: "Accounts", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  await page.evaluate((dirtyGuardShown) => {
    const browser = window as Window & {
      __signatureRaceControl?: { dirtyGuardShown?: boolean };
    };
    if (browser.__signatureRaceControl) {
      browser.__signatureRaceControl.dirtyGuardShown = dirtyGuardShown;
    }
  }, shown);
  return shown;
}

async function dismissDirtyGuard(page: Page) {
  expect(await attemptDirtyGuard(page)).toBe(true);
}

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  if (page.isClosed() || page.url() === "about:blank") return;
  const slug = testInfo.title.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const artifactDirectory = resolve(
    process.cwd(),
    "artifacts/0.5.0/fixes/signature",
  );
  await mkdir(artifactDirectory, { recursive: true });
  const evidence = await page.evaluate(() => {
    const browser = window as Window & {
      __POSTAL_SNAP_TEST__?: { ipcCalls: Array<Record<string, unknown>> };
      __signatureRaceControl?: {
        pending: boolean;
        submitted?: Record<string, unknown>;
      };
    };
    return {
      title: document.title,
      ipcCalls:
        browser.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
          (call) => call.command === "update_account_signature",
        ) ?? [],
      delayedSave: browser.__signatureRaceControl ?? null,
      editorHtml:
        document.querySelector(".signature-rich-content")?.innerHTML ?? null,
      fallbackValue:
        (
          document.querySelector(
            ".signature-fallback textarea",
          ) as HTMLTextAreaElement | null
        )?.value ?? null,
    };
  });
  const screenshot = await page.screenshot({ fullPage: true });
  await writeFile(
    join(artifactDirectory, `${slug}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(join(artifactDirectory, `${slug}.png`), screenshot);
  await testInfo.attach(`${slug}-evidence.json`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach(`${slug}.png`, {
    body: screenshot,
    contentType: "image/png",
  });
});

for (const { density, scale } of variants) {
  const variant = `${density}-${scale * 100}`;

  test(`keeps newer rich signature edits after a successful delayed save: ${variant}`, async ({
    page,
  }) => {
    const { editor, fallback } = await openSignatureEditor(
      page,
      density,
      scale,
    );
    await delayNextSignatureSave(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __signatureRaceControl?: { pending: boolean };
              }
            ).__signatureRaceControl?.pending,
        ),
      )
      .toBe(true);

    await editor.fill("New unsaved rich signature");
    await releaseSignatureSave(page, true);
    await expect(
      page.getByText("Signature saved.", { exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveText("New unsaved rich signature");
    await expect(fallback).toHaveValue("Submitted fallback");
    const dirtyGuardShown = await attemptDirtyGuard(page);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
              (call) => call.command === "update_account_signature",
            ).length,
        ),
      )
      .toBe(2);
    const calls = await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === "update_account_signature",
      ),
    );
    expect(calls?.[1]?.args).toMatchObject({
      signature: "Submitted fallback",
      signatureHtml: expect.stringContaining("New unsaved rich signature"),
    });
    expect(dirtyGuardShown).toBe(true);
  });

  test(`retains plain fallback edits after a failed delayed save: ${variant}`, async ({
    page,
  }) => {
    const { editor, fallback } = await openSignatureEditor(
      page,
      density,
      scale,
    );
    await delayNextSignatureSave(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __signatureRaceControl?: { pending: boolean };
              }
            ).__signatureRaceControl?.pending,
        ),
      )
      .toBe(true);

    await fallback.fill("New unsaved plain fallback");
    await releaseSignatureSave(page, false);
    await expect(fallback).toHaveValue("New unsaved plain fallback");
    await expect(editor.locator("strong")).toHaveText("Submitted");
    await dismissDirtyGuard(page);
    await expect(fallback).toHaveValue("New unsaved plain fallback");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
              (call) => call.command === "update_account_signature",
            ).length,
        ),
      )
      .toBe(2);
    const calls = await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === "update_account_signature",
      ),
    );
    expect(calls?.[1]?.args).toMatchObject({
      signature: "New unsaved plain fallback",
      signatureHtml: expect.stringContaining("<strong>Submitted</strong>"),
    });
  });
}
