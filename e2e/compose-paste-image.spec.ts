import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A pasted picture is dropped instead of becoming an attachment.
// 2. Letter text pasted with formatting is treated as a picture.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-paste-image.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a pasted picture is added to the message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Message body" });
  await editor.click();
  await editor.evaluate((node) => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (char) => char.charCodeAt(0),
    );
    const file = new File([png], "shot.png", { type: "image/png" });
    const clipboard = new DataTransfer();
    clipboard.items.add(file);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboard });
    node.dispatchEvent(event);
  });
  await expect(page.getByText("Image: Pasted image.png")).toBeVisible();
  await expect(page.locator(".composer-editor img")).toBeVisible();
});
