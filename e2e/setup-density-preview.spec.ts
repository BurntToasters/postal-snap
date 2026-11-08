import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// FM16: the setup preview shows three distinct density looks, Normal by default.
// Sender and subject share a line in Normal and Compact; Comfortable stacks them.
// Every density keeps the subject visible and unclipped at 100% and 200% text.
test.beforeEach(async ({ page }) => installMockIpc(page));

type Look = {
  height: number;
  sameLine: boolean;
  subjectVisible: boolean;
  subjectClipped: boolean;
};

async function readLook(page: import("@playwright/test").Page) {
  return page
    .locator(".setup-preview-row")
    .first()
    .evaluate((row) => {
      const strong = row.querySelector("strong")!.getBoundingClientRect();
      const span = row.querySelector("span")!;
      const spanRect = span.getBoundingClientRect();
      return {
        height: row.getBoundingClientRect().height,
        sameLine: Math.abs(spanRect.top - strong.top) < 4,
        subjectVisible:
          getComputedStyle(span).display !== "none" && spanRect.height > 0,
        subjectClipped: span.scrollWidth > span.clientWidth + 1,
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
  expect(looks.compact.sameLine).toBe(true);
  expect(looks.compact.subjectVisible).toBe(true);
  expect(looks.compact.height).toBeLessThan(looks.normal.height);
});

for (const density of ["normal", "comfortable", "compact"] as const) {
  test(`setup preview keeps the subject visible at ${density}, 200% text`, async ({
    page,
  }) => {
    await page.goto("/?firstRun=1");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Interface spacing" })
      .selectOption(density);
    await page
      .getByRole("combobox", { name: "Text size" })
      .selectOption("1.75");
    await expect(page.locator("html")).toHaveAttribute(
      "data-text-scale",
      "large",
    );
    const look = await readLook(page);
    expect(look.subjectVisible).toBe(true);
    expect(look.subjectClipped).toBe(false);
  });
}
