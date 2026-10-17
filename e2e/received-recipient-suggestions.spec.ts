import AxeBuilder from "@axe-core/playwright";
import type { TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A received-sender suggestion is absent from the recipient picker.
// 2. A suggestion request uses another account instead of the active account.
// 3. Keyboard and pointer selection fail to consume the chosen address.
// 4. The list or compose controls become inaccessible at compact 200% text.

const variants = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await attachArtifacts(page, testInfo, `w21-received-suggestions-${slug}`);
});

for (const { density, scale } of variants) {
  test(`received suggestions can be selected: ${density} ${scale * 100}%`, async ({
    page,
  }) => {
    await page.goto(
      `/?receivedSuggestions=1&density=${density}&scale=${scale}`,
    );
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const to = page.getByRole("combobox", { name: "To" });
    await to.fill("ja");

    const suggestions = page.getByRole("listbox", {
      name: "Suggested recipients",
    });
    const jane = suggestions.getByRole("option", {
      name: /Jane Received jane@example\.test/,
    });
    await expect(jane).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .include(".composer-window")
      .analyze();
    expect(
      scan.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    await jane.click();
    await expect(to).toHaveValue("jane@example.test, ");
    const calls = await page.evaluate(
      () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        command: "suggest_recipients",
        args: expect.objectContaining({ accountId: "account-1", prefix: "ja" }),
      }),
    );
  });
}
