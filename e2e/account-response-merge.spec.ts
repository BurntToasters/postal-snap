import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import type { MockShared } from "./mock/context";

// Failure modes covered here:
// 1. A name save response taken before a Reply-To save erases the new Reply-To.
// 2. A signature save response taken before a name save erases the new name.

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
    | "update_account_signature",
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
          }[];
        };
      };
    };
    const account = useAppStore.getState().accounts[0];
    return {
      displayName: account.displayName,
      replyTo: account.replyTo ?? "",
      signature: account.signature ?? "",
    };
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
