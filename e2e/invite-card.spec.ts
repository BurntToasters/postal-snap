import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The invite time is shown in UTC or the sender's zone, not local time.
// 2. Location becomes a link (a tracking or phishing target).
// 3. An RSVP control appears although Postal Snap sends no replies.
// 4. A cancellation looks like a live invitation.
// 5. All-day events show a clock time or a wrong end date.
// 6. Plain messages show a card.

test.use({ locale: "en-US", timezoneId: "America/New_York" });
test.beforeEach(async ({ page }) => installMockIpc(page));

async function open(page: Page, query: string) {
  await page.goto(`/${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  return page.getByRole("region", { name: "Calendar invitation" });
}

test("invitation card shows local time, plain location, and no RSVP", async ({
  page,
}, testInfo) => {
  const card = await open(page, "?invite=request");
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("heading", { name: "Planning lunch" }),
  ).toBeVisible();
  await expect(card).toContainText("Invitation");
  await expect(card).toContainText("Oct 1, 2026, 11:00 AM – 12:00 PM");
  await expect(card).toContainText("Room 4, https://maps.example.test/room4");
  await expect(card).toContainText("Sam Lee <sam.lee@example.test>");
  await expect(card.getByRole("link")).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card).toContainText("does not send replies");
  await expect(
    page.getByRole("option", { name: /Calendar invitation/ }),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "invite-card-request");
});

test("a cancellation is labelled Cancelled", async ({ page }, testInfo) => {
  const card = await open(page, "?invite=cancel");
  await expect(card).toContainText("Cancelled");
  await expect(card).not.toContainText("Invitation");
  await expect(card).toHaveAttribute("data-cancelled", "true");
  await attachArtifacts(page, testInfo, "invite-card-cancel");
});

test("a TZID time converts to this device's zone", async ({
  page,
}, testInfo) => {
  const card = await open(page, "?invite=tzid");
  await expect(card).toContainText("Oct 1, 2026, 9:00 AM – 9:30 AM");
  await attachArtifacts(page, testInfo, "invite-card-tzid");
});

test.describe("other zone", () => {
  test.use({ timezoneId: "Asia/Tokyo" });
  test("the same TZID time follows the device zone", async ({
    page,
  }, testInfo) => {
    const card = await open(page, "?invite=tzid");
    await expect(card).toContainText("Oct 1, 2026, 10:00 PM – 10:30 PM");
    await attachArtifacts(page, testInfo, "invite-card-tzid-tokyo");
  });
});

test("an all-day event shows dates only", async ({ page }, testInfo) => {
  const card = await open(page, "?invite=allDay");
  await expect(card).toContainText("Monday, October 12, 2026");
  await expect(card).toContainText("All day");
  await expect(card).not.toContainText("AM");
  await attachArtifacts(page, testInfo, "invite-card-allday");
});

test("messages without an invitation have no card", async ({
  page,
}, testInfo) => {
  const card = await open(page, "");
  await expect(card).toHaveCount(0);
  await attachArtifacts(page, testInfo, "invite-card-none");
});
