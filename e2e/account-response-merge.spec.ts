import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import type { MockShared } from "./mock/context";

// Failure modes covered here:
// 1. A name save response taken before a Reply-To save erases the new Reply-To.
// 2. A signature save response taken before a name save erases the new name.
// 3. A color save response taken before a Reply-To save erases the new Reply-To.
// 4. A body-format save response taken before a name save erases the new name.
// 5. A stale account list from an auth/offline sync event erases a newer Reply-To.

const variants = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

const artifactDirectory = resolve(
  process.cwd(),
  "artifacts/0.5.0/fixes/account-response-merge",
);

async function openIdentity(page: Page, density: string, scale: number) {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?localMail=1&density=${density}&scale=${scale}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
}

/** Captures the response now, but delivers it only after release(). */
async function holdNextResponse(
  page: Page,
  command:
    | "update_account_display_name"
    | "update_account_reply_to"
    | "update_account_signature"
    | "update_account_color"
    | "update_account_default_body_format"
    | "list_accounts",
  controlKey: string,
) {
  await page.evaluate(
    ({ command, controlKey }) => {
      const browser = window as unknown as Record<string, unknown> & {
        __POSTAL_SNAP_MOCK__?: MockShared;
      };
      const mock = browser.__POSTAL_SNAP_MOCK__;
      if (!mock) throw new Error("Mock IPC was not installed");
      const original = mock.handlers[command];
      if (!original) throw new Error(`Mock handler missing: ${command}`);
      const control: { pending: boolean; release?: () => void } = {
        pending: false,
      };
      browser[controlKey] = control;
      mock.handlers[command] = async (args) => {
        mock.handlers[command] = original;
        // Snapshot at call time, as an older backend response would be.
        const snapshot = structuredClone(await original(args));
        control.pending = true;
        return new Promise((resolve) => {
          control.release = () => {
            control.pending = false;
            resolve(snapshot);
          };
        });
      };
    },
    { command, controlKey },
  );
}

async function waitForHeld(page: Page, controlKey: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          (window as unknown as Record<string, { pending?: boolean }>)[key]
            ?.pending,
        controlKey,
      ),
    )
    .toBe(true);
}

async function release(page: Page, controlKey: string) {
  await page.evaluate((key) => {
    const control = (
      window as unknown as Record<string, { release?: () => void }>
    )[key];
    if (!control?.release) throw new Error("No held response to release");
    control.release();
  }, controlKey);
}

async function readStoreAccount(page: Page) {
  return page.evaluate(async () => {
    // Non-literal path keeps the e2e typecheck from resolving app source.
    const storePath = "/src/store.ts";
    const { useAppStore } = (await import(/* @vite-ignore */ storePath)) as {
      useAppStore: {
        getState: () => {
          accounts: {
            displayName: string;
            replyTo?: string;
            signature?: string;
            color?: string | null;
            defaultBodyFormat?: string;
            syncState: string;
          }[];
        };
      };
    };
    const account = useAppStore.getState().accounts[0];
    return {
      displayName: account.displayName,
      replyTo: account.replyTo ?? "",
      signature: account.signature ?? "",
      color: account.color ?? null,
      defaultBodyFormat: account.defaultBodyFormat ?? "",
      syncState: account.syncState,
    };
  });
}

/** Emits a sync-state event the way the native shell does. */
async function emitSyncState(page: Page, phase: string) {
  await page.evaluate(async (phase) => {
    const internals = (
      window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    await internals.invoke("plugin:event|emit", {
      event: "sync-state",
      payload: { accountId: "account-1", phase },
    });
  }, phase);
}

/** Prepares the mock so the next account list reports an auth failure. */
async function markAuthFailed(page: Page) {
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    mock.account.syncState = "authFailed";
    mock.account.error = "Sign-in failed. Update the account password.";
  });
}

async function saveEvidence(
  page: Page,
  testInfo: TestInfo,
  slug: string,
  evidence: unknown,
) {
  const screenshot = await page.screenshot({ fullPage: true });
  await mkdir(artifactDirectory, { recursive: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(resolve(artifactDirectory, `${slug}.json`), json);
  await writeFile(resolve(artifactDirectory, `${slug}.png`), screenshot);
  await testInfo.attach(`${slug}-evidence.json`, {
    body: json,
    contentType: "application/json",
  });
  await testInfo.attach(`${slug}.png`, {
    body: screenshot,
    contentType: "image/png",
  });
}

for (const { density, scale } of variants) {
  const variant = `${density}-${scale * 100}`;

  test(`late name response keeps newer Reply-To: ${variant}`, async ({
    page,
  }, testInfo) => {
    await openIdentity(page, density, scale);
    await page.getByLabel("Name on mail you send").fill("Held name");
    await holdNextResponse(page, "update_account_display_name", "__nameHeld");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await waitForHeld(page, "__nameHeld");

    await page.getByLabel("Reply-To address").fill("new-reply@example.test");
    await page
      .getByRole("button", { name: "Save Reply-To", exact: true })
      .click();
    await expect(
      page.getByText("Reply-To address saved.", { exact: true }),
    ).toBeVisible();

    await release(page, "__nameHeld");
    await expect(page.getByText("Name saved.", { exact: true })).toBeVisible();

    const store = await readStoreAccount(page);
    await expect(page.getByLabel("Reply-To address")).toHaveValue(
      "new-reply@example.test",
    );
    await expect(page.getByLabel("Name on mail you send")).toHaveValue(
      "Held name",
    );
    await saveEvidence(page, testInfo, `reply-to-${variant}`, {
      variant,
      store,
    });
    expect(store.displayName).toBe("Held name");
    expect(store.replyTo).toBe("new-reply@example.test");
  });

  test(`late signature response keeps newer name: ${variant}`, async ({
    page,
  }, testInfo) => {
    await openIdentity(page, density, scale);
    await page.getByLabel("Email signature").fill("Held signature");
    await holdNextResponse(page, "update_account_signature", "__sigHeld");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await waitForHeld(page, "__sigHeld");

    await page.getByLabel("Name on mail you send").fill("Interleaved name");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(page.getByText("Name saved.", { exact: true })).toBeVisible();

    await release(page, "__sigHeld");
    await expect(
      page.getByText("Signature saved.", { exact: true }),
    ).toBeVisible();

    const store = await readStoreAccount(page);
    await expect(page.getByLabel("Name on mail you send")).toHaveValue(
      "Interleaved name",
    );
    await saveEvidence(page, testInfo, `signature-${variant}`, {
      variant,
      store,
    });
    expect(store.displayName).toBe("Interleaved name");
    expect(store.signature).toBe("Held signature");
  });
}

for (const { density, scale } of variants) {
  const variant = `${density}-${scale * 100}`;

  test(`late color response keeps newer Reply-To: ${variant}`, async ({
    page,
  }, testInfo) => {
    await openIdentity(page, density, scale);
    await holdNextResponse(page, "update_account_color", "__colorHeld");
    await page.getByRole("radio", { name: "Purple", exact: true }).click();
    await waitForHeld(page, "__colorHeld");

    await page.getByLabel("Reply-To address").fill("color-reply@example.test");
    await page
      .getByRole("button", { name: "Save Reply-To", exact: true })
      .click();
    await expect(
      page.getByText("Reply-To address saved.", { exact: true }),
    ).toBeVisible();

    await release(page, "__colorHeld");
    await expect(
      page.getByRole("radio", { name: "Purple", exact: true }),
    ).toHaveAttribute("aria-checked", "true");

    const store = await readStoreAccount(page);
    await expect(page.getByLabel("Reply-To address")).toHaveValue(
      "color-reply@example.test",
    );
    await saveEvidence(page, testInfo, `color-${variant}`, {
      variant,
      store,
    });
    expect(store.color).toBe("purple");
    expect(store.replyTo).toBe("color-reply@example.test");
  });

  test(`late body format response keeps newer name: ${variant}`, async ({
    page,
  }, testInfo) => {
    await openIdentity(page, density, scale);
    await holdNextResponse(
      page,
      "update_account_default_body_format",
      "__formatHeld",
    );
    await page.getByLabel("New messages start as").selectOption("plain");
    await waitForHeld(page, "__formatHeld");

    await page.getByLabel("Name on mail you send").fill("Format interleaved");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(page.getByText("Name saved.", { exact: true })).toBeVisible();

    await release(page, "__formatHeld");
    await expect(page.getByLabel("New messages start as")).toHaveValue("plain");

    const store = await readStoreAccount(page);
    await expect(page.getByLabel("Name on mail you send")).toHaveValue(
      "Format interleaved",
    );
    await saveEvidence(page, testInfo, `body-format-${variant}`, {
      variant,
      store,
    });
    expect(store.displayName).toBe("Format interleaved");
    expect(store.defaultBodyFormat).toBe("plain");
  });

  test(`stale sync account list keeps newer Reply-To: ${variant}`, async ({
    page,
  }, testInfo) => {
    await openIdentity(page, density, scale);
    await markAuthFailed(page);
    await holdNextResponse(page, "list_accounts", "__listHeld");
    await emitSyncState(page, "authFailed");
    await waitForHeld(page, "__listHeld");

    await page.getByLabel("Reply-To address").fill("sync-reply@example.test");
    await page
      .getByRole("button", { name: "Save Reply-To", exact: true })
      .click();
    await expect(
      page.getByText("Reply-To address saved.", { exact: true }),
    ).toBeVisible();

    await release(page, "__listHeld");
    await expect
      .poll(async () => (await readStoreAccount(page)).syncState)
      .toBe("authFailed");

    const store = await readStoreAccount(page);
    await expect(page.getByLabel("Reply-To address")).toHaveValue(
      "sync-reply@example.test",
    );
    await saveEvidence(page, testInfo, `sync-list-${variant}`, {
      variant,
      store,
    });
    expect(store.replyTo).toBe("sync-reply@example.test");
  });
}
