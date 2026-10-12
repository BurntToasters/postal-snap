import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A pasted list of addresses stays one invalid line.
// 2. A pasted name is split apart from its address.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-paste-addresses.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function pasteIntoTo(
  page: import("@playwright/test").Page,
  text: string,
) {
  await page.locator("#composer-to").evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, text);
}

test("pasting several addresses fills To", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const to = page.getByRole("combobox", { name: "To" });
  await expect(to).toBeFocused();
  await pasteIntoTo(page, "jane@example.com\nlee@example.com");
  await expect(to).toHaveValue("jane@example.com, lee@example.com");
  await to.fill("");
  await pasteIntoTo(
    page,
    "Jane Smith <jane@example.com>\nLee <lee@example.com>",
  );
  await expect(to).toHaveValue(
    "Jane Smith <jane@example.com>, Lee <lee@example.com>",
  );
});
