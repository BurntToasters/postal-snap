import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test as base } from "@playwright/test";

type BrowserCoverage = Record<string, unknown>;

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await use(page);
    if (process.env.E2E_COVERAGE !== "true" || page.isClosed()) return;

    const browserCoverage = await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __coverage__?: BrowserCoverage;
          }
        ).__coverage__,
    );
    if (!browserCoverage) {
      throw new Error(
        "E2E coverage was requested, but the Vite app was not instrumented.",
      );
    }

    const outputDirectory = resolve(import.meta.dirname, "../coverage/e2e");
    await mkdir(outputDirectory, { recursive: true });
    const id = createHash("sha256")
      .update(`${testInfo.workerIndex}:${testInfo.testId}:${testInfo.retry}`)
      .digest("hex")
      .slice(0, 20);
    await writeFile(
      resolve(outputDirectory, `${id}.json`),
      `${JSON.stringify(browserCoverage)}\n`,
    );
  },
});

export { expect };
