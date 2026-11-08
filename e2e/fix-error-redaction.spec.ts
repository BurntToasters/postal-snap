import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { attachArtifacts, attachArtifactsAfterEach } from "./ipc";
import { installMockIpc } from "./mock-ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// FM1. A plain Error thrown by a native command shows its raw text, including a local path.
// FM2. An unhandled rejection or window error stays silent, or blanks the app.
// FM3. A limitExceeded payload loses its authored detail.
// FM4. A String(cause) error display reappears under src/ outside tests.

const CATALOG_FALLBACK = "Postal Snap could not finish that action. Try again.";
const SECRET_PATH = "/Users/x/secret.eml";
const LIMIT_DETAIL = "Choose fewer than 50 messages at once.";

test.beforeEach(async ({ page }) => installMockIpc(page));

// Makes the star command reject; the star row action calls it.
async function failStarCommand(page: Page, mode: "plain" | "limit") {
  await page.evaluate(
    ([kind, secret, detail]) => {
      const mock = window.__POSTAL_SNAP_MOCK__;
      if (!mock) throw new Error("Mock IPC was not installed");
      mock.handlers.set_message_flags = () => {
        if (kind === "plain") throw new Error(secret);
        throw mock.mockError("limitExceeded", detail);
      };
    },
    [mode, SECRET_PATH, LIMIT_DETAIL] as const,
  );
}

// Expects the page to be open already, so overrides survive.
async function starFirstRow(page: Page) {
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toBeVisible();
  const wrap = page.locator(".message-row-wrap").filter({ has: row });
  await wrap.hover();
  await wrap.locator('button.row-action[data-action="star"]').click();
}

test("a plain Error shows catalog text and never its path", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await failStarCommand(page, "plain");
  await starFirstRow(page);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(CATALOG_FALLBACK);
  await expect(page.locator("body")).not.toContainText(SECRET_PATH);
  await attachArtifacts(page, testInfo, "fm1-plain-error", {
    shown: await alert.innerText(),
  });
});

test("an unhandled rejection shows a notice and the app stays usable", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toBeVisible();
  await page.evaluate((secret) => {
    void Promise.reject(new Error(secret));
  }, SECRET_PATH);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(CATALOG_FALLBACK);
  await expect(page.locator("body")).not.toContainText(SECRET_PATH);
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await attachArtifacts(page, testInfo, "fm2-unhandled-rejection", {
    shown: await alert.innerText(),
  });
});

test("a window error event shows a notice and never its message", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.evaluate((secret) => {
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error(secret),
        message: secret,
      }),
    );
  }, SECRET_PATH);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(CATALOG_FALLBACK);
  await expect(page.locator("body")).not.toContainText(SECRET_PATH);
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "fm2-window-error", {
    shown: await alert.innerText(),
  });
});

test("a limitExceeded payload keeps its authored detail", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await failStarCommand(page, "limit");
  await starFirstRow(page);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(LIMIT_DETAIL);
  await attachArtifacts(page, testInfo, "fm3-limit-detail", {
    shown: await alert.innerText(),
  });
});

test("no String(cause) error display remains under src outside tests", async ({
  page,
}, testInfo) => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "tests") walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/String\((cause|error|err)\)/.test(line))
            hits.push(`${path.relative(process.cwd(), full)}:${index + 1}`);
        });
    }
  };
  walk(path.join(process.cwd(), "src"));
  await page.goto("/");
  await attachArtifacts(page, testInfo, "fm4-string-cause-sites", {
    hits,
  });
  expect(hits).toEqual([]);
});
