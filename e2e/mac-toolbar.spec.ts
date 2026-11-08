import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// WP4.4 macOS toolbar.
// FM1. Compose keeps a box-shadow, is not white text on an accent pill, or is not pill-shaped.
// FM2. Icon buttons are not transparent, lack a name or tooltip, or hover without --fill-hover.
// FM3. The search field is not a pill on --fill, or its focus ring is not 3px accent.
// FM4. At 200% text the bar grows, wraps, or clips Compose or the update badge.
// FM5. The macOS traffic-light or Windows caption reserve is lost.

test.beforeEach(async ({ page }) => installMockIpc(page));

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

test("FM1 Compose is an accent pill with white text and no colored shadow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/?theme=light");
  const compose = page.getByRole("button", { name: "Compose", exact: true });
  await expect(compose).toBeVisible();
  await expect(compose).toHaveCSS("box-shadow", "none");
  await expect(compose).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(compose).toHaveCSS("background-color", "rgb(0, 111, 201)");
  await expect(compose).toHaveCSS("border-radius", "999px");
  await page.goto("/?theme=dark");
  await expect(compose).toHaveCSS("box-shadow", "none");
  await expect(compose).toHaveCSS("background-color", "rgb(0, 104, 214)");
  await attachArtifacts(page, test.info(), "fm1-compose-dark");
});

test("FM2 icon buttons are transparent pills with names, tooltips and fill hover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/?theme=light");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toHaveAttribute("title", "Settings");
  await expect(settings).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(settings).toHaveCSS("border-radius", "999px");
  await settings.hover();
  await expect(settings).toHaveCSS(
    "background-color",
    "rgba(118, 118, 128, 0.2)",
  );
  for (const button of await page.locator(".app-toolbar .icon-button").all()) {
    await expect(button).toHaveAccessibleName(/.+/);
    await expect(button).toHaveAttribute("title", /.+/);
  }
});

test("FM3 search is a pill on --fill with a 3px accent focus ring", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/?theme=light");
  const box = page.locator(".app-toolbar .search-box");
  await expect(box).toHaveCSS("border-radius", "999px");
  await expect(box).toHaveCSS("background-color", "rgba(118, 118, 128, 0.12)");
  await page
    .getByRole("searchbox", { name: "Search mail", exact: true })
    .focus();
  const shadow = await box.evaluate((node) => getComputedStyle(node).boxShadow);
  expect(shadow).toContain("rgb(0, 111, 201) 0px 0px 0px 3px");
  await attachArtifacts(page, test.info(), "fm3-search-focus");
});

test("FM4 the bar keeps one line at 200% text in a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 840 });
  await page.goto("/?scale=2&updateReady=1&update=1");
  const bar = page.locator(".app-toolbar");
  await expect(bar).toBeVisible();
  const facts = await bar.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    overflowY: node.scrollHeight - node.clientHeight,
    overflowX: node.scrollWidth - node.clientWidth,
  }));
  expect(facts.overflowX).toBeLessThanOrEqual(1);
  expect(facts.overflowY).toBeLessThanOrEqual(1);
  expect(facts.height).toBeLessThanOrEqual(
    await page.evaluate(
      () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 4,
    ),
  );
  const compose = page.getByRole("button", { name: "Compose", exact: true });
  const composeBox = await compose.boundingBox();
  expect(composeBox!.height).toBeLessThanOrEqual(facts.height);
  const badge = page.locator(".update-ready-badge");
  if (await badge.count()) {
    await expect(badge).toHaveCSS("white-space", "nowrap");
    expect((await badge.boundingBox())!.height).toBeLessThanOrEqual(
      facts.height,
    );
  }
  await attachArtifacts(page, test.info(), "fm4-large-text");
});

test.describe("macOS traffic lights", () => {
  test.use({ userAgent: MAC_UA });
  test("FM5 collapsed macOS toolbar clears the traffic lights", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/?hiddenSidebar=1");
    await expect(page.locator(".mail-shell.sidebar-collapsed")).toBeVisible();
    await expect(page.locator(".app-toolbar")).toHaveCSS(
      "padding-left",
      "84px",
    );
  });
});

test.describe("Windows caption", () => {
  test.use({ userAgent: WIN_UA });
  test("FM5 Windows toolbar reserves the caption controls", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/");
    await expect(page.locator(".app-toolbar")).toHaveCSS(
      "padding-right",
      "150px",
    );
  });
});
