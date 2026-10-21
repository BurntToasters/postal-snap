import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A day heading hides how many messages it contains.
// 2. The count includes messages from another day.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/day-count.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("day headings count the messages in the list", async ({ page }) => {
  await page.goto("/?longList=1");
  const list = page.locator(".message-list");
  const first = page.getByRole("option").first();
  await expect(first).toBeVisible();
  const setSize = Number(await first.getAttribute("aria-setsize"));
  // Rows mount as they scroll into view, so collect headings along the way.
  const counts = new Map<string, string>();
  for (let step = 0; step < 20; step += 1) {
    const found = await page
      .locator(".list-day")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector(":scope > span")?.textContent ?? "",
          node.querySelector(".list-day-count")?.textContent ?? "",
        ]),
      );
    for (const [label, count] of found) if (count) counts.set(label, count);
    const atEnd = await list.evaluate(
      (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 2,
    );
    if (atEnd) break;
    await list.evaluate((node) => {
      node.scrollTop += node.clientHeight;
    });
  }
  expect(counts.size).toBeGreaterThan(1);
  let total = 0;
  for (const count of counts.values()) {
    const match = /^(\d+) messages?$/.exec(count);
    expect(match).not.toBeNull();
    total += Number(match?.[1]);
  }
  expect(total).toBe(setSize);
});
