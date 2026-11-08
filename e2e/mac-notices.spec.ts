import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";

// Failure modes (WP4.10 notices, status toasts, avatars, drag chip):
// FM1. Toasts: 12px radius; macOS material with blur; solid on Windows and under reduced transparency.
// FM2. Error notices keep danger styling and role=alert; undo stays in the polite region.
// FM3. An undo notice stays visible while its Undo button is focused, past the default timeout.
// FM4. A toast wraps at 200% text in a narrow window without horizontal overflow.
// FM5. Forced colors: system Canvas background, a solid border, and no shadow or blur.
// FM6. Text and the Undo action reach 4.5:1 against the effective background in light and dark.
// FM7. Reduced motion removes the toast entrance animation.

const VIEWPORT = { width: 1280, height: 900 };

async function openMailbox(page: Page, query = "", width = VIEWPORT.width) {
  await installMockIpc(page);
  await page.setViewportSize({ width, height: VIEWPORT.height });
  await page.goto(`/?localMail=1&${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
}

async function sendDraft(page: Page, body: string) {
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Notice check");
  await page.getByLabel("Message body").pressSequentially(body);
  await page.getByLabel("Message body").press("ControlOrMeta+Enter");
  await expect(page.locator(".composer-window")).toHaveCount(0);
}

/** Archives Weekend plans, which shows an undo notice. */
async function archiveForUndo(page: Page) {
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("e");
  await expect(row).toBeHidden();
  const toast = page.locator(".notice-region .toast", {
    has: page.getByRole("button", { name: "Undo" }),
  });
  await expect(toast).toBeVisible();
  return toast;
}

/** Copies the undo toast and swaps its severity class, keeping the same DOM. */
async function addSeverityToast(page: Page, severity: "success" | "warning") {
  await page.evaluate((sev) => {
    const source = document.querySelector<HTMLElement>(".notice-region .toast");
    if (!source) throw new Error("No toast to clone");
    const copy = source.cloneNode(true) as HTMLElement;
    copy.className = `toast notice notice-${sev}`;
    copy.setAttribute("data-test-clone", sev);
    copy.querySelectorAll("button").forEach((b) => b.remove());
    copy.querySelector("span")!.textContent = `Clone ${sev} notice.`;
    source.parentElement!.append(copy);
  }, severity);
}

async function resolveColor(page: Page, value: string): Promise<string> {
  return page.evaluate((expr) => {
    const el = document.createElement("span");
    el.style.color = expr;
    document.body.append(el);
    const out = getComputedStyle(el).color;
    el.remove();
    return out;
  }, value);
}

async function resolveBackground(page: Page, value: string): Promise<string> {
  return page.evaluate((expr) => {
    const el = document.createElement("span");
    el.style.backgroundColor = expr;
    document.body.append(el);
    const out = getComputedStyle(el).backgroundColor;
    el.remove();
    return out;
  }, value);
}

async function blurOf(locator: Locator) {
  return locator.evaluate((node) => {
    const s = getComputedStyle(node);
    return (
      s.backdropFilter ||
      (s as CSSStyleDeclaration & { webkitBackdropFilter?: string })
        .webkitBackdropFilter ||
      "none"
    );
  });
}

/** WCAG contrast of the text color against the layered backgrounds over the canvas. */
async function contrastOf(locator: Locator, canvas: string) {
  return locator.evaluate((node, canvasRgb) => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgba => {
      const nums = value.match(/[\d.]+/g)!.map(Number);
      return { r: nums[0], g: nums[1], b: nums[2], a: nums[3] ?? 1 };
    };
    const blend = (top: Rgba, base: Rgba): Rgba => ({
      r: top.r * top.a + base.r * (1 - top.a),
      g: top.g * top.a + base.g * (1 - top.a),
      b: top.b * top.a + base.b * (1 - top.a),
      a: 1,
    });
    const lum = (c: Rgba) => {
      const ch = [c.r, c.g, c.b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    // Each translucent ancestor layer composites over the one below it.
    const layers: Rgba[] = [];
    for (let el: Element | null = node; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        layers.push(parse(bg));
      }
    }
    let effective = parse(canvasRgb);
    for (const layer of layers.reverse()) effective = blend(layer, effective);
    const text = blend(parse(getComputedStyle(node).color), effective);
    const [hi, lo] = [lum(text), lum(effective)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }, canvas);
}

// FM1. Radius, material and hairline on macOS; solid elsewhere.
test("FM1 toasts use a 12px radius and macOS material with blur", async ({
  page,
}) => {
  await openMailbox(page, "density=normal");
  const toast = await archiveForUndo(page);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "macos";
    document.documentElement.dataset.reduceTransparency = "false";
  });
  expect(await toast.evaluate((n) => getComputedStyle(n).borderRadius)).toBe(
    "12px",
  );
  expect(await blurOf(toast)).toContain("blur(30px)");
  expect(await toast.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(
    await resolveBackground(page, "var(--menu-material)"),
  );
  expect(await toast.evaluate((n) => getComputedStyle(n).borderTopColor)).toBe(
    await resolveColor(page, "var(--menu-border)"),
  );
  expect(await toast.evaluate((n) => getComputedStyle(n).boxShadow)).not.toBe(
    "none",
  );
});

test("FM1 toasts are solid on Windows", async ({ page }) => {
  await openMailbox(page, "density=normal");
  const toast = await archiveForUndo(page);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "windows";
  });
  expect(await blurOf(toast)).toBe("none");
  expect(await toast.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(
    await resolveBackground(page, "var(--menu-solid)"),
  );
});

// Separate test: the app's settings sync resets this attribute asynchronously,
// so the state is read in the same tick as the change.
test("FM1 toasts are solid under reduced transparency", async ({ page }) => {
  await openMailbox(page, "density=normal");
  await archiveForUndo(page);
  const state = await page.evaluate(() => {
    document.documentElement.dataset.platform = "linux";
    document.documentElement.dataset.reduceTransparency = "true";
    const s = getComputedStyle(
      document.querySelector(".notice-region .toast")!,
    );
    return { blur: s.backdropFilter, bg: s.backgroundColor };
  });
  expect(state.blur).toBe("none");
  expect(state.bg).toBe(await resolveBackground(page, "var(--menu-solid)"));
});

// FM2. Error notices keep danger styling and assertive announcement.
test("FM2 error notices stay assertive with danger styling", async ({
  page,
}) => {
  await openMailbox(page, "density=normal&sendOutcome=needs_attention");
  await sendDraft(page, "Outcome unknown.");
  const error = page.locator(".notice-region .error-toast");
  await expect(error).toContainText("Delivery could not be confirmed.");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(
    page.locator('.notice-region [aria-live="assertive"] [role="alert"]'),
  ).toHaveCount(1);
  expect(await error.evaluate((n) => getComputedStyle(n).color)).toBe(
    await resolveColor(page, "var(--danger-ink)"),
  );
  const politeRegion = page.locator('.notice-region [aria-live="polite"]');
  await expect(politeRegion.locator('[role="alert"]')).toHaveCount(0);
});

test("FM2 undo notices announce politely with no alert role", async ({
  page,
}) => {
  await openMailbox(page, "density=normal");
  const toast = await archiveForUndo(page);
  await expect(toast).not.toHaveAttribute("role", "alert");
  await expect(
    page.locator('.notice-region [aria-live="polite"] .toast'),
  ).toHaveCount(1);
});

// FM3. Focus pauses the undo timeout (the notice stays while focused).
test("FM3 an undo notice stays visible while its Undo button is focused", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.clock.install();
  await openMailbox(page, "density=normal");
  const toast = await archiveForUndo(page);
  await toast.getByRole("button", { name: "Undo" }).focus();
  await page.clock.fastForward(20_000);
  await expect(toast).toBeVisible();
  await attachArtifacts(page, testInfo, "mac-notices-undo-focused");
});

// FM4. 200% text wraps in a narrow window with no overflow.
test("FM4 toasts wrap at 200% without horizontal overflow", async ({
  page,
}, testInfo) => {
  await openMailbox(page, "density=normal&scale=2", 420);
  const toast = await archiveForUndo(page);
  const metrics = await toast.evaluate((el) => ({
    overflow: el.scrollWidth - el.clientWidth,
    pageOverflow:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
  const box = await toast.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(420);
  await attachArtifacts(page, testInfo, "mac-notices-200", metrics);
});

// FM5. Forced colors use system colors, a solid border, and no shadow or blur.
test("FM5 forced colors give toasts a solid border and no material", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openMailbox(page, "density=normal&sendOutcome=needs_attention");
  await sendDraft(page, "Forced colors toast.");
  const error = page.locator(".notice-region .error-toast");
  await expect(error).toBeVisible();
  const style = await error.evaluate((n) => {
    const s = getComputedStyle(n);
    return {
      bg: s.backgroundColor,
      border: s.borderTopStyle,
      shadow: s.boxShadow,
      blur: s.backdropFilter,
      animation: s.animationName,
    };
  });
  expect(style.bg).toBe(await resolveBackground(page, "Canvas"));
  expect(style.border).toBe("solid");
  expect(style.shadow).toBe("none");
  expect(style.blur).toBe("none");
  expect(style.animation).toBe("none");
});

// FM6. Contrast is at least 4.5:1 in both themes for every severity.
for (const theme of ["light", "dark"] as const) {
  test(`FM6 toast text and Undo meet 4.5:1 (${theme})`, async ({
    page,
  }, testInfo) => {
    await openMailbox(
      page,
      `density=normal&theme=${theme}&sendOutcome=needs_attention`,
    );
    const canvas = await resolveBackground(page, "var(--canvas)");
    await sendDraft(page, "Contrast check.");
    const error = page.locator(".notice-region .error-toast");
    await expect(error).toBeVisible();
    expect(
      await contrastOf(error.locator("span"), canvas),
    ).toBeGreaterThanOrEqual(4.5);

    const undo = await archiveForUndo(page);
    expect(
      await contrastOf(undo.locator("span"), canvas),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      await contrastOf(undo.getByRole("button", { name: "Undo" }), canvas),
    ).toBeGreaterThanOrEqual(4.5);

    for (const severity of ["success", "warning"] as const) {
      await addSeverityToast(page, severity);
      const clone = page.locator(`[data-test-clone="${severity}"] span`);
      expect(await contrastOf(clone, canvas)).toBeGreaterThanOrEqual(4.5);
    }
    await page.waitForTimeout(250);
    await attachArtifacts(page, testInfo, `mac-notices-${theme}`);
  });
}

// FM7. Reduced motion removes the entrance animation; motion keeps it.
test("FM7 reduced motion disables the toast entrance animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openMailbox(page, "density=normal");
  const toast = await archiveForUndo(page);
  expect(await toast.evaluate((n) => getComputedStyle(n).animationName)).toBe(
    "none",
  );
});

test("FM7 toasts animate in when motion is allowed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openMailbox(page, "density=normal");
  const toast = await archiveForUndo(page);
  expect(await toast.evaluate((n) => getComputedStyle(n).animationName)).toBe(
    "notice-enter",
  );
});
