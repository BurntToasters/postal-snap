import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// FM16: the setup preview shows three distinct density looks, Normal by default.
test.beforeEach(async ({ page }) => installMockIpc(page));

type Look = { height: number; sameLine: boolean; spanDisplay: string };

async function readLook(page: import("@playwright/test").Page) {
  return page
    .locator(".setup-preview-row")
    .first()
    .evaluate((row) => {
      const strong = row.querySelector("strong")!.getBoundingClientRect();
      const span = row.querySelector("span");
      const spanRect = span?.getBoundingClientRect();
      return {
        height: row.getBoundingClientRect().height,
        sameLine: spanRect ? Math.abs(spanRect.top - strong.top) < 4 : false,
        spanDisplay: span ? getComputedStyle(span).display : "none",
      } satisfies Look;
    });
}

test("setup preview shows Normal by default and three distinct looks", async ({
  page,
}) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const spacing = page.getByRole("combobox", { name: "Interface spacing" });
  await expect(spacing).toHaveValue("normal");

  const looks: Record<string, Look> = {};
  for (const density of ["normal", "comfortable", "compact"] as const) {
    await spacing.selectOption(density);
    await expect(page.locator("html")).toHaveAttribute("data-density", density);
    looks[density] = await readLook(page);
  }

  expect(looks.normal.sameLine).toBe(true);
  expect(looks.normal.height).toBeLessThanOrEqual(37);
  expect(looks.comfortable.sameLine).toBe(false);
  expect(looks.comfortable.height).toBeGreaterThan(looks.normal.height);
  expect(looks.compact.spanDisplay).toBe("none");
  expect(looks.compact.height).toBeLessThan(looks.normal.height);
});
