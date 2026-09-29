import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The composer does not tell Rust which message it answers (id + kind).
// 2. Replied/forwarded is set before SMTP is confirmed: a held (undo or
//    scheduled), queued, or needs-attention send must leave the message
//    unmarked.
// 3. A forward is marked as replied, or the reverse.
// 4. The state has no accessible name in the list or the reader.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openMessage(page: Page, query: string) {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`/${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
}

async function sentDraft(page: Page) {
  return page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as
        { sourceMessageId?: number; sourceKind?: string } | undefined,
  );
}

async function send(page: Page) {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
}

test("a confirmed reply marks the source Replied", async ({
  page,
}, testInfo) => {
  await openMessage(page, "?undoSendOff=1&sendOutcome=sent");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await send(page);
  const draft = await sentDraft(page);
  expect(draft?.sourceMessageId).toBe(10);
  expect(draft?.sourceKind).toBe("reply");
  await expect(
    page.getByRole("option", { name: /Weekend plans.*Replied/ }),
  ).toBeVisible();
  await expect(page.getByTestId("reply-state")).toHaveText("Replied");
  await expect(page.getByRole("option", { name: /Forwarded/ })).toHaveCount(0);
  await attachArtifacts(page, testInfo, "replied-state-reply");
});

test("reply all records its own kind and marks Replied", async ({
  page,
}, testInfo) => {
  await openMessage(page, "?undoSendOff=1&sendOutcome=sent");
  await page.getByRole("button", { name: "Reply all", exact: true }).click();
  await send(page);
  expect((await sentDraft(page))?.sourceKind).toBe("reply_all");
  await expect(
    page.getByRole("option", { name: /Weekend plans.*Replied/ }),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "replied-state-reply-all");
});

test("a confirmed forward marks the source Forwarded, not Replied", async ({
  page,
}, testInfo) => {
  await openMessage(page, "?undoSendOff=1&sendOutcome=sent");
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await send(page);
  const draft = await sentDraft(page);
  expect(draft?.sourceMessageId).toBe(10);
  expect(draft?.sourceKind).toBe("forward");
  await expect(
    page.getByRole("option", { name: /Weekend plans.*Forwarded/ }),
  ).toBeVisible();
  await expect(page.getByTestId("reply-state")).toHaveText("Forwarded");
  await expect(page.getByRole("option", { name: /Replied/ })).toHaveCount(0);
  await attachArtifacts(page, testInfo, "replied-state-forward");
});

for (const outcome of ["needs_attention", "queued", "scheduled"]) {
  test(`a ${outcome} send leaves the source unmarked`, async ({
    page,
  }, testInfo) => {
    await openMessage(page, `?undoSendOff=1&sendOutcome=${outcome}`);
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await send(page);
    expect((await sentDraft(page))?.sourceKind).toBe("reply");
    await expect(
      page.getByRole("option", { name: /Weekend plans/ }),
    ).not.toContainText("Replied");
    await expect(page.getByTestId("reply-state")).toHaveCount(0);
    await attachArtifacts(page, testInfo, `replied-state-${outcome}`);
  });
}

test("a send held for undo leaves the source unmarked", async ({
  page,
}, testInfo) => {
  await openMessage(page, "");
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await send(page);
  await expect(page.getByTestId("reply-state")).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: /Weekend plans/ }),
  ).not.toContainText("Replied");
  await attachArtifacts(page, testInfo, "replied-state-held");
});
