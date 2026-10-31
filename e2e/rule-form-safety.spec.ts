import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";
import { recordIpc, recordedCalls } from "./ipc-recorder";

function artifact(name: string, value: unknown) {
  mkdirSync("test-results/rule-form-safety", { recursive: true });
  writeFileSync(
    `test-results/rule-form-safety/${name}.json`,
    JSON.stringify(value, null, 2),
  );
}

// Failure modes: a delayed create clears text typed after submission, and a
// second click while the first create is in flight sends a duplicate rule.
test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const create = mock.handlers.create_filter_rule;
    mock.handlers.create_filter_rule = async (args) => {
      const value = await create(args);
      await new Promise<void>((resolve) => {
        (window as unknown as { finishRule: () => void }).finishRule = resolve;
      });
      return value;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
});

test("a late create response keeps text typed after submission", async ({
  page,
}) => {
  await page.getByLabel("Rule name", { exact: true }).fill("Submitted rule");
  await page
    .getByLabel("Text to match", { exact: true })
    .fill("submitted@example.test");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as unknown as { finishRule?: unknown }).finishRule,
      ),
    )
    .toBe("function");
  await page.getByLabel("Rule name", { exact: true }).fill("New unsaved rule");
  await page
    .getByLabel("Text to match", { exact: true })
    .fill("newer@example.test");
  await page.evaluate(() =>
    (window as unknown as { finishRule: () => void }).finishRule(),
  );
  await expect(page.getByText("Submitted rule", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Rule name", { exact: true })).toHaveValue(
    "New unsaved rule",
  );
  await expect(page.getByLabel("Text to match", { exact: true })).toHaveValue(
    "newer@example.test",
  );
  artifact("late-response", {
    draft: { name: "New unsaved rule", contains: "newer@example.test" },
    calls: await recordedCalls(page),
  });
});

test("a second click while create is pending sends one call", async ({
  page,
}) => {
  await page.getByLabel("Rule name", { exact: true }).fill("Repeated rule");
  await page
    .getByLabel("Text to match", { exact: true })
    .fill("repeated@example.test");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter(
          (call) => call.command === "create_filter_rule",
        ).length,
    )
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "Add rule", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { finishRule: () => void }).finishRule(),
  );
  await expect
    .poll(
      async () =>
        (await recordedCalls(page)).filter(
          (call) => call.command === "create_filter_rule",
        ).length,
    )
    .toBe(1);
  artifact("duplicate-submit", {
    createCalls: (await recordedCalls(page)).filter(
      (call) => call.command === "create_filter_rule",
    ).length,
  });
});
