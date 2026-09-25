import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

test("context move menu distinguishes nested role folders", async ({
  page,
}) => {
  await page.goto("/?nestedRoleFolders=1");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .click({ button: "right" });

  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(
    menu.getByRole("menuitem", { name: "Move to Sent", exact: true }),
  ).toHaveCount(1);
  await expect(
    menu.getByRole("menuitem", { name: "Move to Work / Sent", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", {
      name: "Move to Personal / Sent",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/nested-role-context-menu.png" });
});

test("reader move list distinguishes nested role folders", async ({ page }) => {
  await page.goto("/?nestedRoleFolders=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();

  const move = page.getByRole("combobox", { name: "Move to folder" });
  const labels = await move
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => option.textContent?.trim()),
    );
  expect(labels).toContain("Sent");
  expect(labels).toContain("Work / Sent");
  expect(labels).toContain("Personal / Sent");
  await page.screenshot({ path: "test-results/nested-role-reader-menu.png" });
});
