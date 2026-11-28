import type { Page } from "@playwright/test";

/** Modifier selected by the app platform, which can differ from the test host. */
export async function appPrimaryModifier(
  page: Page,
): Promise<"Control" | "Meta"> {
  return page.evaluate(() =>
    document.documentElement.dataset.platform === "macos" ? "Meta" : "Control",
  );
}

export async function pressAppShortcut(
  page: Page,
  chord: string,
): Promise<void> {
  await page.keyboard.press(`${await appPrimaryModifier(page)}+${chord}`);
}
