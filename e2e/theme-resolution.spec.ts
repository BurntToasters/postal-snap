import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";

// Failure modes covered here:
// FM1. System dark with no explicit theme leaves the light canvas painted.
// FM2. Switching the system appearance does not update the resolved theme live.
// FM3. An explicit light setting under system dark turns dark anyway.
// FM4. data-resolved-theme is set only after first render, so the page flashes light.
// FM5. An explicit dark setting under system light stays light.

const DARK_CANVAS = "rgb(22, 22, 24)";
const LIGHT_CANVAS = "rgb(245, 245, 247)";

test.beforeEach(async ({ page }) => installMockIpc(page));

async function canvasColor(page: import("@playwright/test").Page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test("FM1: system dark applies dark tokens", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?theme=system");
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );
  expect(await canvasColor(page)).toBe(DARK_CANVAS);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("dark");
  await attachArtifacts(page, testInfo, "theme-system-dark");
});

test("FM2: switching the system appearance updates live without reload", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?theme=system");
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "light",
  );
  await page.evaluate(() => {
    (window as unknown as { __noReload: string }).__noReload = "kept";
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );
  expect(await canvasColor(page)).toBe(DARK_CANVAS);
  expect(
    await page.evaluate(
      () => (window as unknown as { __noReload?: string }).__noReload,
    ),
  ).toBe("kept");
  await attachArtifacts(page, testInfo, "theme-system-live-switch");
});

test("FM3: explicit light under system dark stays light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?theme=light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "light",
  );
  expect(await canvasColor(page)).toBe(LIGHT_CANVAS);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("light");
});

test("FM4: resolved theme is set before DOMContentLoaded", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (
        window as unknown as { __resolvedAtLoad: string | null }
      ).__resolvedAtLoad =
        document.documentElement.dataset.resolvedTheme ?? null;
    });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?theme=system");
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __resolvedAtLoad: string | null })
          .__resolvedAtLoad,
    ),
  ).toBe("dark");
});

test("FM5: explicit dark under system light is dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?theme=dark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-resolved-theme",
    "dark",
  );
  expect(await canvasColor(page)).toBe(DARK_CANVAS);
});
